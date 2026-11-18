(() => {
  "use strict";
  const paths = { a: "icons/a-zip-box.svg", b: "icons/b-zip-folder.svg", c: "icons/c-m-mark.svg", d: "icons/d-open-box.svg" };
  const $ = (selector) => document.querySelector(selector);
  const icons = () => window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
  document.addEventListener("change", (event) => {
    if (event.target.name === "icon") {
      document.querySelectorAll(".icon-option").forEach((card) => card.classList.toggle("selected", card.dataset.option === event.target.value));
      document.querySelectorAll(".chosen-icon").forEach((image) => { image.src = paths[event.target.value]; });
    }
    if (event.target.id === "archive-format") $("#extension").textContent = "." + event.target.value;
    if (event.target.id === "encrypt") {
      $("#password-field").hidden = !event.target.checked;
      if (!event.target.checked) $("#quick-password").value = "";
    }
    $("#quick-status").textContent = "";
  });
  document.addEventListener("click", (event) => {
    const background = event.target.closest("[data-background]");
    if (background) {
      $(".icon-section").classList.toggle("dark", background.dataset.background === "dark");
      document.querySelectorAll("[data-background]").forEach((button) => { const active = button === background; button.classList.toggle("active", active); button.setAttribute("aria-pressed", active); });
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "cancel") {
      $("#quick-form").reset(); $("#extension").textContent = ".zip"; $("#quick-password").value = ""; $("#password-field").hidden = true; $("#quick-error").hidden = true; $("#quick-status").textContent = "已取消 · 预览";
    }
    if (action === "browse") { $("#quick-destination").focus(); $("#quick-destination").select(); }
    if (action === "show-password") {
      const show = $("#quick-password").type === "password";
      $("#quick-password").type = show ? "text" : "password";
      const button = event.target.closest("button");
      button.innerHTML = `<i data-lucide="${show ? "eye-off" : "eye"}"></i>`;
      button.title = button.ariaLabel = show ? "隐藏密码" : "显示密码";
      icons();
    }
  });
  $("#quick-form").addEventListener("submit", (event) => {
    event.preventDefault();
    let error = "";
    if (!$("#archive-name").value.trim() || /[\\/:*?"<>|]/.test($("#archive-name").value)) error = "请输入有效的压缩包名称。";
    else if ($("#encrypt").checked && !$("#quick-password").value) error = "请输入压缩密码。";
    $("#quick-error").textContent = error; $("#quick-error").hidden = !error;
    $("#quick-status").textContent = error ? "" : "设置已确认 · 预览";
  });
  icons();
})();
