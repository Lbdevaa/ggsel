/** Витрина: инициализация интерактива и ряд карточек из каталога API. */
import { api } from './api.js';
import { buy } from './buy.js';
import { initCarousel } from './carousel.js';
import { initCatalogMenu } from './catalog-menu.js';
import { initCurrencySwitch } from './currency.js';

const $ = (id) => document.getElementById(id);

initCatalogMenu({ toggle: $('catalog-toggle'), menu: $('catalog-menu'), backdrop: $('catalog-backdrop') });

initCarousel({
  root: $('banner'),
  track: $('banner-track'),
  dots: $('banner-dots'),
  arrows: Array.from(document.querySelectorAll('.banner__arrow')),
});

initCurrencySwitch($('currency-switch'));

// Чипы категорий и иконки сервисов: только визуальное активное состояние.
$('chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $('chips').querySelectorAll('.chip').forEach((el) => el.setAttribute('aria-pressed', el === chip ? 'true' : 'false'));
});

$('services').addEventListener('click', (e) => {
  const service = e.target.closest('.service');
  if (!service || service.classList.contains('service--more')) return;
  $('services').querySelectorAll('.service').forEach((el) => el.classList.toggle('is-active', el === service));
});

// ---------- карточки ----------

/** В ряду пять карточек. Картинка одна на всех, как в макете; названия и цены из каталога. */
const SHOWCASE_SKUS = ['KEY-GTA5', 'KEY-CS2-PRIME', 'KEY-EFT', 'GIFT-PSN-1000', 'GIFT-XBOX-1500'];
const CARD_IMAGE = 'assets/product-pubg.jpg';

const formatPrice = (value) => `${value.toLocaleString('ru-RU')} ₽`;

function cardTemplate(product) {
  return `
    <li>
      <article class="product-card">
        <div class="product-card__media"><img src="${CARD_IMAGE}" alt="" loading="lazy"></div>
        <div class="product-card__body">
          <h3 class="product-card__title">💥 ${product.name} 🔑 РФ+СНГ</h3>
          <p class="product-card__price">
            <span class="product-card__price-now">${formatPrice(product.price)}</span>
            <span class="product-card__price-old">${formatPrice(product.price * 2)}</span>
          </p>
          <button type="button" class="btn product-card__buy" data-sku="${product.sku}">Купить</button>
        </div>
      </article>
    </li>`;
}

async function renderProducts() {
  const list = $('products');
  try {
    const { products } = await api.get('/api/products');
    const bySku = new Map(products.map((p) => [p.sku, p]));
    const showcase = SHOWCASE_SKUS.map((sku) => bySku.get(sku)).filter(Boolean);
    list.innerHTML = showcase.map(cardTemplate).join('');
  } catch (err) {
    list.innerHTML = `<li class="muted">Не удалось загрузить каталог: ${err.message}</li>`;
  }
}

$('products').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-sku]');
  if (button) buy(button, button.dataset.sku);
});

renderProducts();
