# Поиск людей на сайтах

Настольное приложение для Windows и macOS: проверяет список сайтов, находит фотографии людей и рисует им замену.

**Скачать и установить:** https://landora-landing-generator.github.io/lpg-photo-scan/

- ключ одного сервиса на выбор: OpenRouter, polza.ai, OpenAI или Anthropic;
- список сайтов из Excel, CSV или TXT;
- новый кадр того же размера, сжатый для сайта; свой образец или описание.

## Разработка

```bash
npm install
npm start            # приложение
npm test             # тесты
npm run dist:mac     # .dmg (arm64 + x64)
```

Тег `vX.Y.Z` собирает установщики в GitHub Actions и прикладывает их к релизу.

Разработчик — Андрей Цибин.
