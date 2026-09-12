/**
 * Переключатель валют в блоке пополнения Steam: меняет только активное состояние.
 * Пересчёт суммы по брифу не требуется.
 */
export function initCurrencySwitch(root) {
  root.addEventListener('click', (e) => {
    const option = e.target.closest('.currency-switch__option');
    if (!option) return;
    root.querySelectorAll('.currency-switch__option').forEach((el) => {
      el.setAttribute('aria-pressed', el === option ? 'true' : 'false');
    });
  });
}
