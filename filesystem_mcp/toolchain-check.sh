#!/bin/sh
# Проверка тулчейна аддона. Запускается ДВАЖДЫ:
#   /toolchain-check.sh build    — на сборке образа: падает, если версии ушли
#                                  или если PDF-конвейер не работает
#   /toolchain-check.sh runtime  — на старте: печатает баннер версий в лог
#
# Зачем: версии тулчейна должны быть видны в логе с первой секунды, а
# нерабочий конвейер — ловиться на сборке, а не в бою (урок ha-adb-mcp
# 0.3.3-0.3.5, 21.07.2026: три релиза подряд сломаны поведением внешних
# утилит, диагностика шла вслепую).
set -eu

# Ожидаемые мажоры (Alpine 3.22-stable на 2026-07-21:
# nodejs 22.23.0-r0 (main), poppler 25.04.0-r0 (main, -utils сабпакет);
# Alpine 3.22 main на 2025-07-20: sqlite 3.49.2-r1).
# Патчи внутри ветки допустимы, смена мажора — нет.
EXPECT_NODE_MAJOR=22
EXPECT_POPPLER_MAJOR=25
EXPECT_SQLITE_MAJOR=3

MANIFEST=/toolchain.txt

collect() {
  NODE_V=$(node -v 2>/dev/null | sed 's/^v//' || echo '?')
  POPPLER_V=$(pdftotext -v 2>&1 | sed -n 's/^pdftotext version \([0-9][0-9.]*\).*/\1/p' | head -1)
  [ -n "${POPPLER_V:-}" ] || POPPLER_V='?'
  SQLITE_V=$(sqlite3 -version 2>/dev/null | awk '{print $1}')
  [ -n "${SQLITE_V:-}" ] || SQLITE_V='?'
}

major() { echo "$1" | sed 's/[.-].*//'; }

guard() {
  rc=0
  if [ "$(major "$NODE_V")" != "$EXPECT_NODE_MAJOR" ]; then
    echo "TOOLCHAIN GUARD: nodejs $NODE_V, ожидался мажор $EXPECT_NODE_MAJOR" >&2; rc=1
  fi
  if [ "$(major "$POPPLER_V")" != "$EXPECT_POPPLER_MAJOR" ]; then
    echo "TOOLCHAIN GUARD: poppler $POPPLER_V, ожидался мажор $EXPECT_POPPLER_MAJOR" >&2; rc=1
  fi
  if [ "$(major "$SQLITE_V")" != "$EXPECT_SQLITE_MAJOR" ]; then
    echo "TOOLCHAIN GUARD: sqlite3 $SQLITE_V, ожидался мажор $EXPECT_SQLITE_MAJOR" >&2; rc=1
  fi
  if [ "$rc" != 0 ]; then
    echo "" >&2
    echo "Сборка остановлена: Alpine отдал не тот тулчейн, на котором аддон" >&2
    echo "проверен. Прогони read_pdf_text/read_pdf_page/sqlite_query вручную," >&2
    echo "убедись что всё работает, и обнови EXPECT_*_MAJOR в toolchain-check.sh." >&2
    exit 1
  fi
}

# Смоук ровно того, чем работает сервер: pdfinfo (pdfPageCount),
# pdftoppm с боевыми флагами (read_pdf_page/read_media_file),
# pdftotext -layout (read_pdf_text). PDF генерируется на месте — валидный
# однострочный документ с маркером, офсеты xref посчитаны заранее.
smoke() {
  T=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$T'" EXIT

  cat > "$T/smoke.pdf" << 'PDF_EOF'
%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 80] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 43 >>
stream
BT /F1 12 Tf 20 40 Td (VMCP-SMOKE-OK) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000240 00000 n 
0000000333 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
403
%%EOF
PDF_EOF

  # pdfinfo: сервер парсит строку "Pages:" в pdfPageCount()
  pdfinfo "$T/smoke.pdf" | grep -Eq '^Pages:[[:space:]]+1$' \
    || { echo "SMOKE FAIL: pdfinfo не отдал Pages: 1" >&2; exit 1; }

  # pdftoppm: РОВНО те флаги, что в server.js pdfPageToImage(). stderr глушится:
  # в образе нет шрифтов, poppler пишет "Couldn't find a font for 'Helvetica'"
  # и всё равно рендерит (заменяет её); сборку это не ломает — ниже уже
  # проверяются код выхода, наличие файла и его JPEG-заголовок.
  pdftoppm -jpeg -r 120 -scale-to 1400 -f 1 -l 1 "$T/smoke.pdf" "$T/page" 2>/dev/null \
    || { echo "SMOKE FAIL: pdftoppm упал" >&2; exit 1; }
  J=$(ls "$T"/page*.jpg 2>/dev/null | head -1)
  [ -n "$J" ] && [ -s "$J" ] || { echo "SMOKE FAIL: pdftoppm не дал JPEG" >&2; exit 1; }
  head -c 2 "$J" | od -An -tx1 | tr -d ' \n' | grep -qi 'ffd8' \
    || { echo "SMOKE FAIL: pdftoppm дал не JPEG" >&2; exit 1; }

  # pdftotext: РОВНО те флаги, что в server.js pdfToText()
  pdftotext -layout -f 1 -l 1 "$T/smoke.pdf" - | grep -q 'VMCP-SMOKE-OK' \
    || { echo "SMOKE FAIL: pdftotext не извлёк маркер" >&2; exit 1; }

  # sqlite3: та же командная строка, что sqlite.js использует в runSqlite() —
  # включая -cmd "PRAGMA hard_heap_limit=...", добавленный в 2.7.1.
  sqlite3 "$T/smoke.db" "CREATE TABLE t(x); INSERT INTO t VALUES (1),(2),(3);" \
    || { echo "SMOKE FAIL: не удалось создать тестовую базу" >&2; exit 1; }
  HHL_OUT=$(sqlite3 -cmd "PRAGMA hard_heap_limit=268435456;" -readonly -safe -json "$T/smoke.db" "SELECT COUNT(*) AS n FROM t")
  # Эхо прагмы — единственное место, где на каждом вызове видно, что ЭТА
  # сборка sqlite3 действительно приняла лимит: незнакомое имя PRAGMA обычно
  # молча ничего не делает, поэтому без этой проверки апдейт Alpine, тихо
  # уронивший поддержку hard_heap_limit, не дал бы вообще никакого симптома —
  # до первого настоящего OOM, который положит весь процесс аддона.
  #
  # Форма эха не закреплена железно: этот же смоук на реальной сборке уже
  # один раз вернул голое "268435456" там, где sqlite.js параллельно видел
  # "[{\"hard_heap_limit\":268435456}]" — при внешне идентичной командной
  # строке (сравнивали байт в байт, разницы не нашли). Значение то же самое,
  # сериализация — нет; причина не установлена, гоняться за ней дальше не
  # стали. Проверяется поэтому именно значение, а не одна конкретная форма —
  # ровно то же самое исправление, что и в sqlite.js (see HEAP_LIMIT_ECHO_CANDIDATES).
  echo "$HHL_OUT" | grep -Eq '^(\[\{"hard_heap_limit":268435456\}\]|268435456([^0-9]|$))' \
    || { echo "SMOKE FAIL: hard_heap_limit не подтверждён эхом прагмы (получено: $HHL_OUT)" >&2; exit 1; }
  echo "$HHL_OUT" | grep -q '"n":3' \
    || { echo "SMOKE FAIL: sqlite3 -readonly -safe -json не вернул ожидаемый COUNT(*)" >&2; exit 1; }

  # -safe должна отбивать ATTACH — без этого запрос читает любой файл на
  # диске в обход проверки зон (см. sqlite-spec.md). Успешный ATTACH — провал.
  if sqlite3 -readonly -safe "$T/smoke.db" "ATTACH '/etc/passwd' AS x;" >/dev/null 2>&1; then
    echo "SMOKE FAIL: -safe не заблокировал ATTACH" >&2; exit 1
  fi
}

collect
case "${1:-runtime}" in
  build)
    guard
    smoke
    {
      echo "built: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
      echo "nodejs: $NODE_V"
      echo "poppler(pdftotext/pdftoppm/pdfinfo): $POPPLER_V"
      echo "pdf-pipeline(pdfinfo+pdftoppm+pdftotext): ok"
      echo "sqlite3: $SQLITE_V"
      echo "sqlite-pipeline(readonly+safe+json, ATTACH blocked): ok"
    } > "$MANIFEST"
    echo "Toolchain OK -> $(tr '\n' '; ' < "$MANIFEST")"
    ;;
  runtime)
    echo "node $NODE_V | poppler $POPPLER_V | sqlite3 $SQLITE_V"
    ;;
  *)
    echo "usage: $0 build|runtime" >&2; exit 2
    ;;
esac
