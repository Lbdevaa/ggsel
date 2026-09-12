/**
 * Меню «Каталог»: открытие по кнопке, закрытие повторным кликом, кликом вне меню и по Esc.
 * Клик по пункту левой колонки переключает активный раздел (детализация колонок не требуется).
 */
export function initCatalogMenu({ toggle, menu, backdrop }) {
  const isOpen = () => !menu.hidden;

  function open() {
    menu.hidden = false;
    backdrop.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
  }

  function close() {
    menu.hidden = true;
    backdrop.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isOpen()) close();
    else open();
  });

  backdrop.addEventListener('click', close);

  document.addEventListener('click', (e) => {
    if (!isOpen()) return;
    if (menu.contains(e.target) || toggle.contains(e.target)) return;
    close();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      close();
      toggle.focus();
    }
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.catalog-menu__item');
    if (!item) return;
    menu.querySelectorAll('.catalog-menu__item').forEach((el) => el.classList.toggle('is-active', el === item));
  });

  return { open, close, isOpen };
}
