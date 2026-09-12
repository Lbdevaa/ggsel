/**
 * Баннер-карусель: автопрокрутка, стрелки, точки-индикаторы.
 * Автопрокрутка ставится на паузу при наведении и при уходе вкладки в фон.
 */
export function initCarousel({ root, track, dots, arrows, intervalMs = 5000 }) {
  const slides = Array.from(track.children);
  let index = 0;
  let timer = null;

  dots.innerHTML = slides
    .map((_, i) => `<li><button type="button" class="banner__dot" data-index="${i}" aria-label="Слайд ${i + 1}"></button></li>`)
    .join('');
  const dotButtons = Array.from(dots.querySelectorAll('.banner__dot'));

  function goTo(next) {
    index = (next + slides.length) % slides.length;
    track.style.transform = `translateX(-${index * 100}%)`;
    dotButtons.forEach((dot, i) => {
      dot.classList.toggle('is-active', i === index);
      dot.setAttribute('aria-current', i === index ? 'true' : 'false');
    });
  }

  function start() {
    stop();
    timer = setInterval(() => goTo(index + 1), intervalMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  arrows.forEach((arrow) =>
    arrow.addEventListener('click', () => {
      goTo(index + Number(arrow.dataset.dir));
      start();
    }),
  );
  dots.addEventListener('click', (e) => {
    const dot = e.target.closest('.banner__dot');
    if (!dot) return;
    goTo(Number(dot.dataset.index));
    start();
  });

  root.addEventListener('mouseenter', stop);
  root.addEventListener('mouseleave', start);
  root.addEventListener('focusin', stop);
  root.addEventListener('focusout', start);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

  goTo(0);
  start();

  return { goTo, stop, start };
}
