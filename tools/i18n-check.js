// Проверка словаря web/i18n.json: все ли строки интерфейса переведены и совпадают ли подстановки {0}.
// Запуск: npm i --no-save acorn acorn-walk && node tools/i18n-check.js . web/i18n.json
// Без второго аргумента печатает список строк, которые должны быть в словаре.
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const repo = process.argv[2];
const cyr = /[А-Яа-яЁё]/;
const keys = new Set();
const add = (s) => { s = s.trim(); if (cyr.test(s)) keys.add(s); };

const src = fs.readFileSync(path.join(repo, 'web/app.js'), 'utf8');
const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
const concat = (n) => {
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'BinaryExpression' && n.operator === '+') {
    const l = concat(n.left), r = concat(n.right);
    return l !== null && r !== null ? l + r : null;
  }
  return null;
};
walk.full(ast, (node) => {
  if (node.type === 'Literal' && typeof node.value === 'string') add(node.value);
  if (node.type === 'TemplateLiteral') {
    let s = '';
    node.quasis.forEach((q, i) => { s += q.value.cooked; if (i < node.expressions.length) s += `{${i}}`; });
    add(s);
  }
  if (node.type === 'BinaryExpression') { const v = concat(node); if (v) add(v); }
});

const html = fs.readFileSync(path.join(repo, 'web/index.html'), 'utf8');
for (const m of html.matchAll(/>([^<>]+)</g)) add(m[1]);
for (const m of html.matchAll(/(?:title|placeholder)="([^"]+)"/g)) add(m[1]);

for (const f of ['main.cpp', 'installer.cpp']) {
  const c = fs.readFileSync(path.join(repo, 'src', f), 'utf8');
  for (const m of c.matchAll(/TrF?\(L"((?:[^"\\]|\\.)*)"/g)) add(JSON.parse(`"${m[1]}"`));
}

// Сообщения C++, которые приходят в интерфейс.
[
  'Папка не найдена: {0}', 'Укажите имя папки', 'Имя папки не может содержать символы \\ / : * ? " < > |',
  'Родительская папка не найдена', 'Файл с таким именем уже существует', 'Не удалось создать папку: {0}',
  'Укажите полный путь к локальной папке', 'Не удалось создать папку {0}: {1}', 'Неизвестная программа: {0}',
  'Обновлений нет — установлена последняя версия', 'Не удалось запустить процесс (код {0})',
  'Некорректный адрес сервера', 'Некорректное имя пользователя', 'Некорректный порт',
  'Не найден OpenSSH-клиент (ssh.exe). Установите компонент Windows «Клиент OpenSSH».',
  'Не удалось создать ключ: {0}', 'Не удалось прочитать ключ {0}', 'Неверный пароль, или сервер не разрешает вход по паролю.',
  'Не удалось установить ключ: {0}',
  'Ключ добавлен в authorized_keys, но сервер его не принимает (проверьте права на ~/.ssh и настройки sshd).\n{0}',
  'Сервер не ответил вовремя',
  'Ключ сервера изменился по сравнению с known_hosts. Проверьте сервер и удалите старую запись (ssh-keygen -R {0}).',
  'Сервер отказал в подключении — проверьте адрес и порт (запущен ли SSH на сервере?)\n({0})',
  'Не удалось найти сервер с таким адресом\n({0})', 'Сервер не отвечает — проверьте адрес, порт и сеть\n({0})',
  'Сервер недоступен — нет маршрута до хоста\n({0})', 'Сервер разорвал соединение\n({0})',
  'Не удалось подключиться (код {0})', 'Нет доступа к папке: {0}', 'Неожиданный ответ сервера:\n{0}',
  'Недопустимое имя папки', 'Папка «{0}» уже существует', 'Нет прав на создание папки здесь',
  'Некорректный адрес (код {0})', 'Не удалось открыть HTTP-сессию (код {0})', 'Не удалось подключиться к серверу (код {0})',
  'Не удалось создать запрос (код {0})', 'Нет связи с GitHub (код {0})', 'Сервер ответил кодом {0}', 'Обрыв загрузки (код {0})',
  'Не удалось записать файл (код {0})', 'Неожиданный ответ GitHub', 'Не удалось создать временный файл',
  'Файл скачался не полностью', 'Скачанный файл не похож на программу', 'Не удалось сохранить файл обновления',
].forEach(add);

// Служебное и промежуточные куски склеек — не переводятся отдельно.
const IGNORE = [
  /^cd \{0\} 2>/, /^\u001b/, /^\{0\}\{1\}$/,
  /^Работаем с проектом .*ls -la'\.$/, /^Работаем с проектом .*без пароля: \{2\}\.$/, /^Все команды по проекту/, /^Файлы читай и редактируй/,
];
const list = [...keys].filter((k) => !IGNORE.some((re) => re.test(k)));

const dictPath = process.argv[3];
if (!dictPath) {
  console.log(list.map((k) => JSON.stringify(k)).join('\n'));
  console.error(`${list.length} keys`);
  process.exit(0);
}
const d = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
const dk = Object.keys(d);
const have = new Set(dk);
const missing = list.filter((k) => !have.has(k));
const unused = dk.filter((k) => !keys.has(k));
console.log(`keys in code: ${list.length}, in dictionary: ${dk.length}`);
if (missing.length) console.log(`MISSING:\n${missing.map((k) => `  ${JSON.stringify(k)}`).join('\n')}`);
if (unused.length) console.log(`UNUSED:\n${unused.map((k) => `  ${JSON.stringify(k)}`).join('\n')}`);
const ph = (x) => (x.match(/\{\d\}/g) || []).sort().join();
let problems = missing.length;
for (const lang of ['en', 'de', 'fr', 'es', 'pt', 'it', 'tr', 'zh', 'ja']) {
  const empty = dk.filter((k) => !d[k][lang]);
  const bad = dk.filter((k) => d[k][lang] && ph(k) !== ph(d[k][lang]));
  problems += empty.length + bad.length;
  if (empty.length || bad.length) console.log(`${lang}: empty ${empty.length}, placeholder mismatch ${bad.length}\n  ${bad.join('\n  ')}`);
}
console.log(problems ? `PROBLEMS: ${problems}` : 'OK: all keys translated, placeholders match');
process.exit(problems ? 1 : 0);
