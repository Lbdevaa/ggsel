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

## Как воспроизвести проверку гонок

_Заполняется на этапе 2._

## Как обеспечена однократная выдача

_Заполняется на этапе 2._

## Время

См. [TIMELOG.md](TIMELOG.md).
