# CMD Manager

Менеджер консолей для работы с несколькими проектами в [Claude Code](https://claude.com/claude-code) на Windows. Все консоли собраны в одном окне. Это удобнее, чем держать десяток окон PowerShell.

*English summary below.*

## Возможности

- **Вкладки.** Каждая консоль открывается во вкладке, переключение кликом или по `Ctrl+Tab` / `Ctrl+1…9`.
- **Сетка 1 / 2 / 4 / 6 / 8.** Можно видеть сразу несколько консолей. Вкладку можно перетащить в нужную ячейку, а двойной клик по заголовку разворачивает ячейку на всё окно.
- **«Создать проект».** Программа создаёт папку, открывает в ней PowerShell и запускает `claude --dangerously-skip-permissions`.
- **«Открыть проект».** Выбираете существующую папку, дальше всё то же самое.
- **История проектов.** Достаточно одного клика, чтобы открыть консоль и запустить Claude. Список отсортирован по дате последнего открытия, есть поиск и закрепление проектов.
- **Названия проектов.** Отображаемое имя может отличаться от имени папки.
- **Своя команда запуска** для отдельного проекта, например `claude --continue`.
- **Индикатор работы.** Точка на вкладке пульсирует, пока Claude работает. Когда Claude закончил или ждёт ответа, вкладка подсвечивается, а кнопка на панели задач мигает.
- Сочетание `Shift+Enter` вставляет перевод строки в поле ввода Claude. Копирование и вставка работают через `Ctrl+C` / `Ctrl+V` и правую кнопку мыши.
- При закрытии программы завершаются все запущенные в ней процессы, «висящих» консолей не остаётся.

## Как это устроено

- **C++ / Win32.** Консоли запускаются через [ConPTY](https://learn.microsoft.com/windows/console/creating-a-pseudoconsole-session) (тот же механизм, что в Windows Terminal). Нативная часть также отвечает за окно, диалоги выбора папки, хранение состояния и Job Object, который убирает дочерние процессы при выходе.
- **WebView2 + [xterm.js](https://xtermjs.org/).** Отвечают за отрисовку терминалов, вкладки, сетку и список проектов. xterm.js — это движок терминала из VS Code, поэтому полноэкранный интерфейс Claude Code отображается корректно.

```
src/main.cpp          окно, WebView2, обработка сообщений из интерфейса
src/pty_session.*     одна консоль: ConPTY + процесс + потоки чтения
web/                  интерфейс (HTML/CSS/JS) и xterm.js
third_party/          WebView2 SDK, nlohmann/json
```

Данные (список проектов, настройки, положение окна) хранятся в `%APPDATA%\CMDManager`.

## Требования

- Windows 10 1809+ или Windows 11 (нужна поддержка ConPTY)
- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (в Windows 11 уже установлен)
- Установленный [Claude Code](https://docs.claude.com/claude-code), команда `claude` должна быть доступна в `PATH`

## Сборка

Нужна Visual Studio 2022 (или Build Tools) с компонентом **«Разработка классических приложений на C++»**. Все зависимости уже лежат в репозитории.

```bat
build.bat
```

Результат:
- `build\CMDManager.exe` — запускается прямо из репозитория, интерфейс берётся из `web\`;
- `dist\CMDManager\` — переносимая папка (exe + `web\`), её можно скопировать куда угодно.

## Горячие клавиши

| Клавиши | Действие |
|---|---|
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | следующая / предыдущая вкладка |
| `Ctrl+1…9` | перейти к вкладке по номеру |
| `Ctrl+Shift+N` | создать проект |
| `Ctrl+Shift+O` | открыть проект |
| `Ctrl+Shift+W` | закрыть консоль |
| `Ctrl+Shift+Enter` | развернуть консоль / вернуть сетку |
| `Ctrl+Shift+B` | показать / скрыть список проектов |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0`, `Ctrl+колесо` | размер шрифта |
| `Shift+Enter` | новая строка в Claude Code |
| `Ctrl+C` при выделении, правый клик | копировать / вставить |

## Отладка

- `set CMDM_DEVTOOLS=1` — включает DevTools (F12) и контекстное меню WebView2.
- `set CMDM_DATA_DIR=путь` — использовать отдельную папку данных, например для тестов.

## ⚠️ О флаге `--dangerously-skip-permissions`

По умолчанию Claude запускается с флагом `--dangerously-skip-permissions`. В этом режиме Claude выполняет команды и меняет файлы без подтверждения. Команду запуска можно поменять в **Настройках** (для всех проектов) или в свойствах отдельного проекта.

## Лицензия

MIT, см. [LICENSE](LICENSE). Сторонние компоненты: xterm.js (MIT), nlohmann/json (MIT), Microsoft WebView2 SDK (BSD-3-Clause).

---

## English summary

CMD Manager is a small Windows app (C++/Win32 + ConPTY + WebView2 + xterm.js) that gathers all your Claude Code consoles in one window. It provides tabs, a 1/2/4/6/8 split grid, one-click "create/open project" that starts PowerShell in the folder and runs `claude --dangerously-skip-permissions`, a named project history, and activity/attention indicators. To build, run `build.bat` with Visual Studio 2022 (C++ workload) installed.
