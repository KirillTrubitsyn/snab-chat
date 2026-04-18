# Файловое хранилище

## Что проверять

### 1. Загрузка файлов

- **MIME spoofing**: проверяется ли реальный тип файла (magic bytes через `file-type` / `python-magic`), или только расширение / Content-Type из заголовка? Атакующий может загрузить `.html` или `.svg` с XSS-кодом, замаскировав под изображение.
- **Path traversal**: валидируются ли имена файлов? Блокируются ли `..`, ведущий `/`, null bytes, Unicode-обходы (NFKC normalization), case-sensitivity bypass? Может ли атакующий перезаписать произвольный файл через имя загрузки?
- **Размер файла**: есть ли серверный лимит на размер загрузки? Клиентский лимит без серверного — не защита.
- **Опасные типы**: блокируются ли `.exe`, `.sh`, `.php`, `.jsp`, `.html`, `.svg`, `.xml`, `.cmd`, `.bat`, `.ps1`? Используется ли allowlist расширений вместо blocklist?
- **Content-Disposition**: при отдаче файла — `Content-Disposition: attachment` для пользовательских файлов, чтобы браузер не рендерил их inline.
- **Nested archive attacks**: zip bomb, zip slip (path traversal через архив), nested format (zip-in-zip).

### 2. Storage buckets

- Какие buckets публичные, какие приватные?
- Публичный bucket с пользовательскими данными (документы, аватары с метаданными, PDF с EXIF) — потенциальная утечка.
- Есть ли RLS-политики на storage (Supabase Storage)?
- **S3 bucket policies**: проверь, нет ли `Principal: "*"` с broad actions.
- **Block Public Access** включён на уровне account и bucket (AWS)?
- Versioning включён для критичных buckets?

### 3. Signed URLs

- Какой TTL у signed URLs? Более 1 часа для чувствительных файлов — риск. Рекомендация: минуты.
- Требуется ли аутентификация для генерации signed URL, или любой может запросить?
- Signed URL привязан к конкретному пользователю (через IP binding или user context в signature), или универсален?
- Signed URL содержит ли минимально необходимые permissions (read, не write)?

### 4. Серверная обработка файлов

Обработка загруженных файлов — отдельный attack surface:
- **Изображения** (resize, thumbnail): уязвимости в ImageMagick (ImageTragick), libvips, sharp. Используется ли актуальная версия?
- **PDF**: XXE при парсинге, JavaScript в PDF, form injection. Используется ли sandbox?
- **SVG**: не рендерится как HTML с `<script>` или `<foreignObject>`? `svg-sanitize` применён?
- **Office documents** (docx, xlsx): macros, external references, DDE injection. Processing в isolated environment?
- **Archive extraction** (zip, tar): zip slip (`../`), zip bomb, symlink attacks. Использование библиотек с protection (`unzipper` с `dontWriteOutside`).
- **Media transcoding** (ffmpeg): SSRF через подачу URL как источника, RCE через форматы с неявной обработкой.

### 5. EXIF и metadata leakage

- При загрузке изображений — удаляется ли EXIF (geolocation, device info)?
- PDF metadata (author, editor, comments) — очищается?
- Microsoft Office (docx, xlsx) — track changes и comments могут содержать sensitive data.

## Как искать в коде

```bash
# Загрузка файлов
grep -rn "upload\|multer\|formidable\|busboy\|FileUpload\|IncomingForm\|UploadedFile\|file_upload\|multipart" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go"

# Storage buckets
grep -rn "bucket\|storage\.\|getPublicUrl\|createSignedUrl\|upload.*storage\|s3.*put\|S3Client\|putObject" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go"

# MIME / type checking
grep -rn "mimetype\|content.type\|file\.type\|magic\|file-type\|mime" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go"

# Path validation
grep -rn "path\.join\|path\.resolve\|filename\|originalname\|\\.replace.*\\.\\." --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rb" --include="*.go"

# Image processing
grep -rn "sharp\|jimp\|imagemagick\|pillow\|PIL\|libvips" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="package.json" --include="requirements.txt"

# PDF processing
grep -rn "pdf-parse\|pdfjs\|pdfkit\|reportlab\|pypdf" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="package.json" --include="requirements.txt"

# Archive
grep -rn "unzipper\|adm-zip\|jszip\|tar-stream\|zipfile\|tarfile" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="package.json" --include="requirements.txt"
```

## Классификация

| Находка | Severity |
|---|---|
| Возможность загрузить исполняемый файл и получить доступ через web | Critical |
| Path traversal в имени загружаемого файла | High |
| Публичный bucket с пользовательскими PII | High |
| Нет проверки magic bytes, только Content-Type | Medium |
| Signed URL TTL > 1 час для чувствительных файлов | Medium |
| Нет серверного лимита на размер файла | Medium |
| EXIF / metadata не очищаются | Low |
