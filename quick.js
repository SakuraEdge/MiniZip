(() => {
  "use strict";
  const api = window.miniZip;
  const $ = (selector) => document.querySelector(selector);
  let task = null;
  let initialized = false;
  const icons = () => window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
  async function call(method, payload) {
    if (!api) throw new Error("请使用 MiniZip 桌面版打开快速压缩。");
    const result = await api[method](payload);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }
  function error(message) { $("#quick-error").hidden = !message; $("#quick-error").textContent = message || ""; resize(); }
  function resize() { if (api) api.quickResize(Math.ceil(document.body.scrollHeight)).catch(() => {}); }
  function renderTask(value) {
    task = value;
    const active = task.status === "running";
    $("#options").disabled = active;
    $("#submit").hidden = task.status === "completed";
    $("#submit").disabled = active || !initialized;
    $("#cancel").textContent = task.status === "completed" ? "完成" : active ? "取消任务" : "取消";
    $("#cancel").disabled = active && !task.canCancel;
    $("#progress-area").hidden = false;
    $("#phase").textContent = task.status === "completed" ? "压缩完成" : task.status === "failed" ? "压缩失败" : task.status === "cancelled" ? "已取消" : ({ starting: "准备中", compressing: "正在压缩", verifying: "正在校验", committing: "正在保存" }[task.phase] || "处理中");
    $("#progress-value").textContent = task.progress === null ? "" : task.progress + "%";
    $("#progress-bar").style.width = (task.progress || 0) + "%";
    $(".progress-track").classList.toggle("indeterminate", active && task.progress === null);
    $("#quick-result").hidden = task.status !== "completed";
    $("#reveal").hidden = task.status !== "completed";
    if (task.status === "completed") $("#quick-result").textContent = `${window.MiniZipCore.formatBytes(task.result.size)} · ${task.result.path}`;
    error(task.error?.message || ""); resize();
  }
  async function init() {
    try {
      const info = await call("quickReady");
      $("#source-name").textContent = info.name; $("#source-name").title = info.name;
      $("#source-info").textContent = `${info.files} 个文件 · ${info.folders} 个文件夹 · ${window.MiniZipCore.formatBytes(info.size)}`;
      $("#source-paths").textContent = info.sources.join("\n");
      $("#archive-name").value = info.defaultName; $("#quick-destination").value = info.destination;
      $("#archive-format").value = info.format || "zip"; $("#extension").textContent = "." + $("#archive-format").value;
      $("#level").value = info.level || "normal";
      const version = document.querySelector(".version"); if (version && info.version) version.textContent = info.version;
      $("#options").disabled = false; $("#submit").disabled = false; initialized = true; resize();
    } catch (err) { $("#source-name").textContent = "无法读取所选文件"; error(err.message); }
  }
  $("#archive-format").addEventListener("change", () => { $("#extension").textContent = "." + $("#archive-format").value; });
  $("#encrypt").addEventListener("change", () => { $("#password-field").hidden = !$("#encrypt").checked; if (!$("#encrypt").checked) $("#quick-password").value = ""; resize(); });
  $("#source-detail").addEventListener("click", () => { $("#source-paths").hidden = !$("#source-paths").hidden; resize(); });
  $("#show-password").addEventListener("click", () => { const show = $("#quick-password").type === "password"; $("#quick-password").type = show ? "text" : "password"; $("#show-password").innerHTML = `<i data-lucide="${show ? "eye-off" : "eye"}"></i>`; $("#show-password").title = $("#show-password").ariaLabel = show ? "隐藏密码" : "显示密码"; icons(); });
  $("#browse").addEventListener("click", async () => { try { const selected = await call("quickDestination"); if (selected) $("#quick-destination").value = selected; } catch (err) { error(err.message); } });
  $("#cancel").addEventListener("click", async () => { try { $("#quick-password").value = ""; if (task?.status === "running") await call("quickCancel"); else await call("quickClose"); } catch (err) { error(err.message); } });
  $("#reveal").addEventListener("click", () => call("quickReveal").catch((err) => error(err.message)));
  $("#quick-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("#archive-name").value.trim();
    if (!name || /[\\/:*?"<>|]/.test(name)) { error("请输入有效的压缩包名称。"); return; }
    if ($("#encrypt").checked && !$("#quick-password").value) { error("请输入压缩密码。"); return; }
    $("#submit").disabled = true; error("");
    try {
      const value = await call("quickStart", { name, format: $("#archive-format").value, level: $("#level").value, destination: $("#quick-destination").value, password: $("#encrypt").checked ? $("#quick-password").value : "" });
      if (value) { $("#quick-password").value = ""; renderTask(value); }
      else $("#submit").disabled = false;
    } catch (err) { $("#submit").disabled = false; error(err.message); }
  });
  if (api) api.onTask(renderTask);
  icons(); init();
})();
