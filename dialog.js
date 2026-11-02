const attached = new WeakSet();

// dialogのbackdropイベントはdialog自身をtargetにする。余白・子要素と外側を座標で区別する。
export function dismissOnOutsideClick(dialog) {
  if (attached.has(dialog)) return;
  attached.add(dialog);
  let pressedOutside = false;
  const outside = (event) => {
    if (event.target !== dialog) return false;
    const rect = dialog.getBoundingClientRect();
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  };
  dialog.addEventListener("pointerdown", (event) => {
    pressedOutside = event.button === 0 && outside(event);
  });
  dialog.addEventListener("pointercancel", () => {
    pressedOutside = false;
  });
  dialog.addEventListener("click", (event) => {
    if (dialog.open && pressedOutside && outside(event)) dialog.close();
    pressedOutside = false;
  });
}
