# ---------------------------------------------------------------------------
# Базовый образ.
# build.yaml объявлен Supervisor'ом устаревшим — WARNING печатается в КАЖДОЙ
# сборке ("uses build.yaml which is deprecated"), а с Supervisor 2026.04.0
# аргумент BUILD_FROM больше не подставляется по умолчанию. Когда поддержку
# build.yaml уберут, `FROM ${BUILD_FROM}` окажется пустым и сборка развалится
# у всех, кто ставит аддон. Поэтому база задаётся здесь, а build.yaml удалён.
#
# База — arch-less мультиарх-манифест, БЕЗ подстановки ${BUILD_ARCH}:
# дефолт арки был бы тихим неверным ответом (на ARM молча собралась бы
# amd64-база — issue #1 этого репозитория был ровно про кривую базу на
# aarch64). Arch-less манифест buildx резолвит сам по --platform, ошибиться
# негде. Одновременно это переезд 3.20 → 3.22: 3.20/3.21 вне окна поддержки
# docker-base (актуальные arch-less теги: 3.22, 3.23, 3.24). Смена базы меняет
# тулчейн (nodejs 20→22, poppler 24→25) — осознанно проходит через guard и
# смоук в toolchain-check.sh.
# Если Supervisor передаст BUILD_FROM (старые версии) — тот переопределит
# дефолт, это штатно.
# ---------------------------------------------------------------------------
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.22
FROM ${BUILD_FROM}

# Единый источник правды по версии: config.yaml -> BUILD_VERSION (Supervisor
# передаёт штатно) -> сюда -> server.js (process.env.ADDON_VERSION) и run.sh.
# До 2.4.0 версия дублировалась в server.js и run.sh вручную — баннер run.sh
# уже уезжал в прод с чужой версией (2.2.1 в релизе 2.3.0).
ARG BUILD_VERSION=0.0.0-dev
ENV ADDON_VERSION=${BUILD_VERSION}

# ---------------------------------------------------------------------------
# Тулчейн: nodejs (сервер, без npm-зависимостей) + poppler-utils
# (pdftotext/pdftoppm/pdfinfo для read_pdf_text / read_pdf_page /
# read_media_file). npm из списка убран — он не использовался никогда:
# package.json в образе нет, server.js и proxy.js живут на встроенных модулях.
#
# Жёстко пинить `pkg=версия-rN` нельзя: Alpine удаляет из ветки старые версии,
# и такой пин ломает установку у ВСЕХ при первом же security-патче
# (gitlab.alpinelinux.org/alpine/abuild#9996). Поэтому пакеты плавают внутри
# ветки, но сборка ПАДАЕТ, если ушёл мажор или если PDF-конвейер перестал
# работать — см. toolchain-check.sh.
# Состояние Alpine 3.22-stable на 2026-07-21:
#   nodejs 22.23.0-r0 (main), poppler 25.04.0-r0 (main, -utils сабпакет)
# ---------------------------------------------------------------------------
RUN apk add --no-cache nodejs poppler-utils

COPY run.sh /run.sh
COPY toolchain-check.sh /toolchain-check.sh
COPY proxy.js /proxy.js
COPY server.js /server.js
RUN chmod a+x /run.sh /toolchain-check.sh \
    && /toolchain-check.sh build

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="addon" \
  io.hass.arch="amd64|aarch64"

CMD [ "/run.sh" ]
