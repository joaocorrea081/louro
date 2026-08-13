// Louro — mantem a janela do motor de reconhecimento fora da vista.
//
// O Chrome so existe aqui como motor de fala; quem aparece pro usuario e a
// bolinha. Esta janela fica minimizada e sumida da barra de tarefas, do
// alternador (Alt+Tab) e do pager.
//
// Normalmente quem faz isso e a regra do KWin instalada pelo install.sh. Este
// script e o plano B, pra quando a regra precisar ser aplicada na hora:
//
//   busctl --user call org.kde.KWin /Scripting org.kde.kwin.Scripting \
//     loadScript ss "<caminho>/kwin-hide-engine.js" "louro-hide"
//   busctl --user call org.kde.KWin /Scripting org.kde.kwin.Scripting start

const TARGET_CLASS = "chrome-127.0.0.1__-Default";

function hideEngine(window) {
  if (!window || window.resourceClass != TARGET_CLASS) return;
  window.skipTaskbar = true;
  window.skipPager = true;
  window.skipSwitcher = true;
  window.minimized = true;
}

const existing = workspace.windowList ? workspace.windowList() : workspace.clientList();
for (const window of existing) hideEngine(window);

// o motor pode ser reiniciado depois; pega a janela nova tambem
if (workspace.windowAdded) {
  workspace.windowAdded.connect(hideEngine);
} else if (workspace.clientAdded) {
  workspace.clientAdded.connect(hideEngine);
}
