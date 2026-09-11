# GGSel MVP — магазин цифровых товаров с однократной выдачей ключей

MVP витрины и продажи цифровых товаров: витрина по макету + флоу «заказ → оплата (вебхук-заглушка) → выдача ключа из пула → статус заказа» с гарантией однократной выдачи под гонками и восстановлением после сбоев.

Бриф и скриншоты макета: [docs/brief/](docs/brief/). План работ: [plan.md](plan.md). Учёт времени: [TIMELOG.md](TIMELOG.md).

## Запуск

Нужен Node.js 22.13+ (используется встроенный `node:sqlite`, нативных зависимостей нет).

```
npm install
npm run dev
```

Поднимаются три процесса: API на http://localhost:3300 (оттуда же отдаётся фронт), поставщик A на 4001, поставщик B на 4002. Переменные окружения необязательны, их список с дефолтами в [.env.example](.env.example).

Через Docker:

```
docker compose up --build
```

Сбросить базы (при остановленных процессах): `npm run reset`.

Проверка руками:

```
curl localhost:3300/api/products
curl -X POST localhost:4001/issue -H 'content-type: application/json' -d '{"request_id":"req_1","sku":"KEY-GTA5","order_id":"ord_1"}'
curl localhost:4001/stats
```

## Структура

```
frontend/   витрина, страница заказа, админка (HTML / CSS / JS без фреймворков)
backend/    REST API, SQLite, воркер выдачи (Node.js + Express)
suppliers/  две заглушки поставщиков по контракту: /issue, /restock, /chaos, /stats
scripts/    dev.mjs (три процесса), reset-db.mjs, race.mjs (сценарии гонок, этап 2)
docs/       бриф, решения, сценарии гонок
```

## API

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/products` | каталог |
| POST | `/api/orders` | `{order_id, sku}` → заказ. `order_id` вида `ord_<uuid>` генерирует клиент, повтор с тем же id возвращает тот же заказ (`200` вместо `201`) |
| GET | `/api/orders/:id` | заказ и история переходов; `key_code` виден только в статусе `delivered` |
| POST | `/api/orders/:id/pay?result=success\|failed` | эмулятор платёжки: формирует событие и шлёт его на `/webhook/payment` по HTTP |
| POST | `/webhook/payment` | вебхук по контракту: `{event_id, order_id, status, amount, currency, created_at}`. Всегда `200`, в ответе `result`: `applied`, `duplicate`, `ignored`, `pending_order`, `amount_mismatch` |

Поставщики (`4001` A, `4002` B): `POST /issue`, `POST /restock {count | keys}`, `POST /chaos {fail_rate, timeout_rate, hang_ms}`, `GET /stats`.

Статусы заказа: `created → paid → delivering → delivered`, ветки `payment_failed`, `out_of_stock`, `delivery_failed`. Переходы описаны в [backend/src/domain/statuses.js](backend/src/domain/statuses.js).

## Как воспроизвести проверку гонок

_Заполняется на этапе 2._

## Как обеспечена однократная выдача

_Заполняется на этапе 2._

## Время

См. [TIMELOG.md](TIMELOG.md).
