-- Voyago database schema (MySQL 5.7+ / 8.x / MariaDB).
-- The app runs this automatically on start-up, so you do not have to import it by hand.
-- You can also import it yourself in phpMyAdmin if you prefer.

CREATE TABLE IF NOT EXISTS destinations (
  code      CHAR(3)       NOT NULL PRIMARY KEY,
  name      VARCHAR(60)   NOT NULL,
  country   VARCHAR(60)   NOT NULL,
  latitude  DECIMAL(8,4)  NOT NULL,
  longitude DECIMAL(8,4)  NOT NULL,
  emoji     VARCHAR(16)   NOT NULL,
  tagline   VARCHAR(120)  NOT NULL,
  color1    CHAR(7)       NOT NULL,
  color2    CHAR(7)       NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS promo_codes (
  code        VARCHAR(20)  NOT NULL PRIMARY KEY,
  percent_off TINYINT      NOT NULL,
  min_pax     TINYINT      NOT NULL DEFAULT 1,
  description VARCHAR(120) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bookings (
  reference          VARCHAR(12)   NOT NULL PRIMARY KEY,
  status             VARCHAR(12)   NOT NULL DEFAULT 'confirmed',
  trip_id            VARCHAR(12)   NOT NULL,
  travel_date        DATE          NOT NULL,
  cabin              VARCHAR(12)   NOT NULL,
  from_code          CHAR(3)       NOT NULL,
  to_code            CHAR(3)       NOT NULL,
  departs            CHAR(5)       NOT NULL,
  arrives            CHAR(5)       NOT NULL,
  arrival_day_offset TINYINT       NOT NULL DEFAULT 0,
  duration_min       SMALLINT      NOT NULL,
  stops              TINYINT       NOT NULL DEFAULT 0,
  airline            VARCHAR(40)   NOT NULL,
  flight_no          VARCHAR(10)   NOT NULL,
  contact_email      VARCHAR(160)  NOT NULL,
  contact_phone      VARCHAR(30)   NOT NULL,
  card_brand         VARCHAR(12)   NOT NULL,
  card_last4         CHAR(4)       NOT NULL,
  passengers_count   TINYINT       NOT NULL,
  fare_per_person    DECIMAL(10,2) NOT NULL,
  subtotal           DECIMAL(10,2) NOT NULL,
  discount           DECIMAL(10,2) NOT NULL DEFAULT 0,
  promo_code         VARCHAR(20)   NULL,
  taxes              DECIMAL(10,2) NOT NULL,
  fees               DECIMAL(10,2) NOT NULL,
  total              DECIMAL(10,2) NOT NULL,
  refund_percent     TINYINT       NULL,
  refund_amount      DECIMAL(10,2) NULL,
  created_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_at       DATETIME      NULL,
  INDEX idx_trip_date (trip_id, travel_date, status),
  INDEX idx_email (contact_email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS passengers (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  booking_ref VARCHAR(12)  NOT NULL,
  first_name  VARCHAR(40)  NOT NULL,
  last_name   VARCHAR(40)  NOT NULL,
  dob         DATE         NOT NULL,
  passport    VARCHAR(9)   NOT NULL,
  seat        VARCHAR(4)   NOT NULL,
  CONSTRAINT fk_passenger_booking FOREIGN KEY (booking_ref) REFERENCES bookings (reference) ON DELETE CASCADE,
  INDEX idx_booking (booking_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
