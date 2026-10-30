# Builds domains.xls (old binary Excel) for the import test: `python make_xls.py` with xlwt installed.
import xlwt

wb = xlwt.Workbook(encoding="utf-8")
ws = wb.add_sheet("Сайты")
rows = [
    ["Название", "Сайт", "Контакт", "Заметка"],
    ["Ремонт кофемашин", "https://www.auto-coffee-service.ru/remont?utm=1", "info@auto-coffee-service.ru", "основной"],
    ["Компьютеры", "москва.частная-компьютерная.рф", "8 800 555-35-35", "цена 1.5 тыс"],
    ["Мастер Рома", "master-roma.ru/", "", "photo.jpg"],
    ["Дубль", "MASTER-ROMA.RU", "", ""],
]
for r, row in enumerate(rows):
    for c, value in enumerate(row):
        ws.write(r, c, value)
ws.write(5, 1, xlwt.Formula('HYPERLINK("https://komputer-remont.ru/";"сайт")'))
wb.save("domains.xls")
