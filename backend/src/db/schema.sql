-- Схема API. Применяется целиком при старте, все выражения идемпотентны.

CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,                 -- ord_<uuid>, приходит с клиента
  sku           TEXT NOT NULL,
  base_amount   INTEGER NOT NULL,                 -- цена товара
  discount      INTEGER NOT NULL DEFAULT 0,
  amount        INTEGER NOT NULL,                 -- к оплате, считает сервер
  promo_code    TEXT,
  status        TEXT NOT NULL CHECK (status IN (
                  'created', 'paid', 'delivering', 'delivered',
                  'payment_failed', 'out_of_stock', 'delivery_failed')),
  key_code      TEXT,                             -- выданный ключ
  supplier      TEXT,                             -- A | B
  request_id_a  TEXT NOT NULL,                    -- req_<id>_A, фиксируется при создании
  request_id_b  TEXT NOT NULL,                    -- req_<id>_B
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);

-- Все входящие вебхуки. PRIMARY KEY по event_id даёт идемпотентность приёма.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id     TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL,
  status       TEXT NOT NULL,                     -- paid | failed
  amount       INTEGER,
  payload      TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  applied      INTEGER NOT NULL DEFAULT 0         -- 1, когда событие изменило заказ
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_order ON webhook_events (order_id);

-- Очередь выдачи. UNIQUE(order_id) исключает две задачи на один заказ.
CREATE TABLE IF NOT EXISTS delivery_jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL UNIQUE,
  state      TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
  run_after  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_jobs_state ON delivery_jobs (state, run_after);

CREATE TABLE IF NOT EXISTS promocodes (
  code      TEXT PRIMARY KEY,
  type      TEXT NOT NULL CHECK (type IN ('percent', 'amount')),
  value     INTEGER NOT NULL,
  max_uses  INTEGER NOT NULL,
  used      INTEGER NOT NULL DEFAULT 0
);

-- Повтор создания заказа с тем же order_id не списывает промокод второй раз.
CREATE TABLE IF NOT EXISTS promo_usages (
  order_id  TEXT PRIMARY KEY,
  code      TEXT NOT NULL,
  used_at   TEXT NOT NULL
);

-- Аудит переходов статусов.
CREATE TABLE IF NOT EXISTS order_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  reason       TEXT,
  at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events (order_id);
