/**
 * Modal form dialog for data source setup, etc.
 * title: dialog heading
 * fields: array of { key, label, type?, placeholder? }
 * onSave: called with { key: value } map when user clicks Save
 */
export interface FormField {
  key: string;
  label: string;
  type?: string;      // "text" | "password" — default "text"
  placeholder?: string;
  value?: string;     // pre-filled value
}

/** Trap Tab/Shift-Tab within a container */
function trapFocus(container: HTMLElement): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusable = container.querySelectorAll<HTMLElement>(
      'input, button, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
}

export function formDialog(
  title: string,
  description: string,
  fields: FormField[],
  saveLabel: string,
  onSave: (values: Record<string, string>) => void
): void {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";

  const box = document.createElement("div");
  box.className = "modal-box";

  const h3 = document.createElement("h3");
  h3.className = "modal-title";
  h3.textContent = title;
  box.appendChild(h3);

  if (description) {
    const desc = document.createElement("div");
    desc.className = "modal-desc";
    // Render markdown links from setup guides (trusted SKILL.md content)
    const escaped = description.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    desc.innerHTML = escaped.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>'
    );
    box.appendChild(desc);
  }

  const form = document.createElement("div");
  form.className = "modal-form";

  let errorEl: HTMLElement | null = null;

  for (const field of fields) {
    const group = document.createElement("div");
    group.className = "form-group";
    group.style.marginBottom = "0.6rem";

    const label = document.createElement("label");
    label.className = "form-label";
    label.textContent = field.label;

    const input = document.createElement("input");
    input.className = "form-input";
    input.type = field.type ?? "text";
    input.placeholder = field.placeholder ?? field.label;
    input.dataset.key = field.key;
    if (field.value) input.value = field.value;

    group.appendChild(label);
    group.appendChild(input);
    form.appendChild(group);
  }

  box.appendChild(form);

  const actions = document.createElement("div");
  actions.className = "confirm-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn-primary";
  saveBtn.textContent = saveLabel;

  function close() {
    document.removeEventListener("keydown", focusTrap);
    overlay.remove();
  }

  function doSave() {
    const values: Record<string, string> = {};
    form.querySelectorAll<HTMLInputElement>("input[data-key]").forEach((inp) => {
      if (inp.value.trim()) values[inp.dataset.key!] = inp.value.trim();
    });
    if (Object.keys(values).length === 0) {
      // Show validation error instead of silently closing
      if (!errorEl) {
        errorEl = document.createElement("p");
        errorEl.style.cssText = "color: var(--danger); font-size: 0.8rem; margin: 0.4rem 0 0;";
        form.appendChild(errorEl);
      }
      errorEl.textContent = "Please fill in at least one field.";
      return;
    }
    close();
    onSave(values);
  }

  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  saveBtn.addEventListener("click", doSave);

  // Enter to submit from any input
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doSave(); }
  });

  // Escape to close
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // Focus trap
  const focusTrap = trapFocus(box);
  document.addEventListener("keydown", focusTrap);

  // Focus first input
  const firstInput = form.querySelector("input") as HTMLInputElement | null;
  if (firstInput) firstInput.focus();
}

/**
 * Confirmation dialog using our own styling (consistent with the rest of the app).
 * Always use this instead of window.confirm().
 */
export function confirmDialog(message: string, onConfirm: () => void): void {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";

  const box = document.createElement("div");
  box.className = "confirm-box";

  const msg = document.createElement("p");
  msg.textContent = message;

  const actions = document.createElement("div");
  actions.className = "confirm-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "btn btn-danger";
  confirmBtn.textContent = "Confirm";

  function close() {
    document.removeEventListener("keydown", focusTrap);
    overlay.remove();
  }

  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  confirmBtn.addEventListener("click", () => { close(); onConfirm(); });

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  box.appendChild(msg);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // Focus trap
  const focusTrap = trapFocus(box);
  document.addEventListener("keydown", focusTrap);

  confirmBtn.focus();
}

/** Simple info dialog with a title, markdown description, and Close button. */
export function infoDialog(title: string, description: string): void {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";

  const box = document.createElement("div");
  box.className = "modal-box";

  const h3 = document.createElement("h3");
  h3.className = "modal-title";
  h3.textContent = title;
  box.appendChild(h3);

  const desc = document.createElement("div");
  desc.className = "modal-desc";
  const escaped = description.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  desc.innerHTML = escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );
  box.appendChild(desc);

  const actions = document.createElement("div");
  actions.className = "confirm-actions";
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn btn-primary";
  closeBtn.textContent = "Close";

  function close() {
    document.removeEventListener("keydown", focusTrap);
    overlay.remove();
  }

  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  actions.appendChild(closeBtn);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const focusTrap = trapFocus(box);
  document.addEventListener("keydown", focusTrap);
  closeBtn.focus();
}
