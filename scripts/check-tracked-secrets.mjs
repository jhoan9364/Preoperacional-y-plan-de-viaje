import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const JWT_KIND = 'JWT con rol privado (service_role u otro distinto de anon)';
const rolJwt = (token) => {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).role ?? null;
  } catch {
    return null; // payload ilegible: se trata como hallazgo
  }
};

const signatures = [
  ['Supabase PAT', 'sbp_[A-Za-z0-9_-]{20,}'],
  ['Supabase secret key', 'sb_secret_[A-Za-z0-9_-]{20,}'],
  ['GitHub classic PAT', 'ghp_[A-Za-z0-9]{30,}'],
  ['GitHub fine-grained PAT', 'github_pat_[A-Za-z0-9_]{30,}'],
  ['OpenAI API key', 'sk-[A-Za-z0-9_-]{40,}'],
  ['GitLab PAT', 'glpat-[A-Za-z0-9_-]{20,}'],
  ['AWS access key', 'AKIA[0-9A-Z]{16}'],
  ['Google API key', 'AIza[0-9A-Za-z_-]{35}'],
  ['Slack token', 'xox[baprs]-[A-Za-z0-9-]{10,}'],
  ['Private key', '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'],
  ['PostgreSQL URI con contraseña', 'postgres(ql)?://[^ :/@]+:[^ @/]{8,}@'],
  // Añadido en la skill arranque-seguro: el guardián de Orocam no veía una clave
  // `service_role` (JWT). La anon key también es un JWT y es pública por diseño
  // (va en los HTML), así que se decodifica el payload y solo se ignora role=anon.
  [JWT_KIND, 'eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}'],
];

// Marcadores de plantilla: NO son credenciales. Sin este filtro,
// `.claude/settings.example.json` ("postgresql://postgres:CLAVE@db.XXXX...")
// producía 7 hallazgos falsos en --history y sepultaba a los verdaderos, que se
// imprimen en la misma lista. Un guardián que siempre grita deja de leerse.
// Se aplica SOLO al fragmento que casó, nunca a la línea entera, y los formatos
// de token real no pueden contener estas palabras (p. ej. `sbp_` + 40 hex).
const marcadorPlantilla = /(CLAVE|CONTRASE|PASSWORD|TU_|SU_|YOUR_|CHANGE_?ME|REDACT|EJEMPLO|EXAMPLE|PLACEHOLDER|XXXX|\*{3,}|<[^>]*>)/i;

// Hallazgos históricos YA RESUELTOS: la credencial fue revocada y se comprobó
// inerte, pero la cadena sigue en el historial porque se decidió no reescribirlo.
// Sin esta lista, `--history` fallaría PARA SIEMPRE por un secreto muerto y el
// guardián volvería a ser ruido que nadie lee (así sobrevivió meses la fuga de
// Portal Orocam).
//
// Se identifica por revisión + archivo, NUNCA por el valor: un secreto no se
// reescribe en el repositorio ni siquiera muerto. Solo aplica al historial; si la
// misma cadena reapareciera en el worktree o en el índice, se seguiría bloqueando.
// Añadir una entrada SOLO después de revocar y verificar (p. ej. HTTP 401):
//   { kind: 'Supabase PAT', revision: '<sha completo>', file: '<ruta>',
//     nota: '<prefijo>... revocado el <fecha>; verificado HTTP 401' },
const revocadosVerificados = [];

const estaRevocado = ({ kind, file, revision }) => revocadosVerificados.some(
  (r) => r.kind === kind && r.file === file && r.revision === revision,
);

const requestedModes = process.argv.slice(2);
const allowedModes = new Set(['--head', '--history', '--staged', '--worktree']);
if (requestedModes.length > 1 || requestedModes.some((mode) => !allowedModes.has(mode))) {
  throw new Error('Uso: node check-tracked-secrets.mjs [--worktree|--staged|--head|--history]');
}
const mode = requestedModes[0] || '--worktree';
const findings = [];
let ignoradosPorMarcador = 0;
let jwtAnonIgnorados = 0;

// Una sola invocación de git por lote, con TODOS los patrones a la vez.
// Antes se lanzaba un `git grep` por cada patrón y por cada revisión: con 11
// firmas y 146 commits eran 1.606 procesos y el comando excedía los 2 minutos,
// así que en la práctica nadie corría `check:secrets:history`. Por lotes tarda
// ~12 s. El coste de un guardián lento es que no se ejecuta.
const LOTE = 100;

const scanBatch = (revisions) => {
  const args = ['grep', '-I', '-n', '-E'];
  if (mode === '--worktree') args.push('--untracked');
  if (mode === '--staged') args.push('--cached');
  for (const [, pattern] of signatures) args.push('-e', pattern);
  if (revisions.length) args.push(...revisions);
  else if (mode === '--head') args.push('HEAD');
  args.push('--', '.');

  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 1) return; // git grep: 1 = sin coincidencias
  if (result.status !== 0) {
    throw new Error('No se pudo revisar Git: ' + (result.stderr || '').trim());
  }

  const conRevision = revisions.length > 0 || mode === '--head';
  for (const linea of result.stdout.split(/\r?\n/).filter(Boolean)) {
    // Con revisión: <rev>:<archivo>:<nº>:<contenido>   sin ella: <archivo>:<nº>:<contenido>
    const partes = conRevision
      ? /^([^:]+):([^:]+):(\d+):([\s\S]*)$/.exec(linea)
      : /^([^:]+):(\d+):([\s\S]*)$/.exec(linea);
    if (!partes) continue;
    const revision = conRevision ? partes[1] : null;
    const file = conRevision ? partes[2] : partes[1];
    const contenido = conRevision ? partes[4] : partes[3];

    for (const [kind, pattern] of signatures) {
      // Todas las coincidencias de la línea: una anon key no debe tapar a una
      // service_role que vaya detrás.
      for (const encontrado of contenido.matchAll(new RegExp(pattern, 'g'))) {
        if (kind === JWT_KIND) {
          // Sin filtro de marcadores: el base64 puede contener «SU_» o «TU_» por azar.
          if (rolJwt(encontrado[0]) === 'anon') { jwtAnonIgnorados += 1; continue; }
        } else if (marcadorPlantilla.test(encontrado[0])) {
          ignoradosPorMarcador += 1;
          continue;
        }
        findings.push({ kind, file, revision });
      }
    }
  }
};

if (mode === '--history') {
  const history = spawnSync('git', ['rev-list', '--all'], { cwd: repoRoot, encoding: 'utf8' });
  if (history.status !== 0) {
    throw new Error('No se pudo enumerar el historial Git: ' + (history.stderr || '').trim());
  }
  const revisions = history.stdout.split(/\r?\n/).filter(Boolean);
  for (let i = 0; i < revisions.length; i += LOTE) scanBatch(revisions.slice(i, i + LOTE));
} else {
  scanBatch([]);
}

const todos = [...new Map(findings.map((item) => [
  [item.kind, item.file, item.revision || ''].join('|'),
  item,
])).values()];

const yaRevocados = todos.filter(estaRevocado);
const uniqueFindings = todos.filter((item) => !estaRevocado(item));

const scopeLabel = {
  '--worktree': 'el árbol de trabajo y archivos nuevos no ignorados',
  '--staged': 'el índice preparado para commit',
  '--head': 'el commit HEAD',
  '--history': 'el historial alcanzable por refs locales',
}[mode];

const notaMarcadores = (ignoradosPorMarcador
  ? ' (' + ignoradosPorMarcador + ' coincidencia(s) ignorada(s) por ser marcadores de plantilla)'
  : '') + (jwtAnonIgnorados
  ? ' (' + jwtAnonIgnorados + ' JWT con role=anon ignorado(s): la anon key es pública por diseño)'
  : '');

// Los ya revocados se listan siempre, aunque no rompan el build: quedan a la vista
// para que nadie los descubra de nuevo dentro de un año y los crea vivos.
for (const { kind, file, revision, nota } of yaRevocados.map(
  (f) => ({ ...f, nota: revocadosVerificados.find((r) => r.revision === f.revision)?.nota }),
)) {
  console.log('· Ya revocado (no bloquea): ' + kind + ': ' + file + ' @ ' + revision.slice(0, 12));
  if (nota) console.log('  ' + nota);
}

if (uniqueFindings.length) {
  console.error('Se detectaron posibles credenciales privadas en ' + scopeLabel + ':');
  for (const { kind, file, revision } of uniqueFindings) {
    const suffix = revision ? ' @ ' + revision.slice(0, 12) : '';
    console.error('- ' + kind + ': ' + file + suffix);
  }
  console.error('Retira la credencial y revócala en su proveedor; el script nunca muestra su valor.' + notaMarcadores);
  process.exitCode = 1;
} else {
  console.log('OK: no se detectaron patrones conocidos de credenciales en ' + scopeLabel + '.' + notaMarcadores);
}
