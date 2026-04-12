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
    const desc = document.createElement("p");
    desc.className = "modal-desc";
    desc.textContent = description;
    box.appendChild(desc);
  }

  const form = document.createElement("div");
  form.className = "modal-form";

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

  function close() { overlay.remove(); }

  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  saveBtn.addEventListener("click", () => {
    const values: Record<string, string> = {};
    form.querySelectorAll<HTMLInputElement>("input[data-key]").forEach((inp) => {
      if (inp.value.trim()) values[inp.dataset.key!] = inp.value.trim();
    });
    close();
    onSave(values);
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

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

  function close() { overlay.remove(); }

  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  confirmBtn.addEventListener("click", () => { close(); onConfirm(); });

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  box.appendChild(msg);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  confirmBtn.focus();
}
