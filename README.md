# NihongoShiken V2 (static)

## Chạy local

```powershell
python -m http.server 5500
```

Mở: http://127.0.0.1:5500/

> Không mở `index.html` bằng `file://` — trình duyệt sẽ chặn `fetch` JSON.

## Cấu trúc

| Thư mục / file | Nội dung |
|---|---|
| `index.html`, `css/`, `js/` | UI tĩnh |
| `data/` | Catalog + JSON đề |
| `tools/` | Script import/patch đề |
| `riki/` | CSV nguồn Tổng ôn N3 |
| `old/` | Bản Flask/Supabase cũ (V1) |

## Data

- 8 đề **Tổng ôn N3** (`track: n3_review`) từ `riki/extracted_csv`
- Đề N2 từ export Supabase (trừ sample)

| Mã | CSV nguồn | Chủ đề |
|---|---|---|
| `N3-TO-K01` | `tong_on_bai_1.csv` | Hán tự |
| `N3-TO-V01` | `tong_on_bai_2.csv` | Từ vựng 1 |
| `N3-TO-G01` | `tong_on_bai_3.csv` | Ngữ pháp 1 |
| `N3-TO-V02` | `tong_on_bai_4.csv` | Từ vựng 2 |
| `N3-TO-G02` | `tong_on_bai_5.csv` | Ngữ pháp 2 |
| `N3-TO-G03` | `tong_on_bai_6.csv` | Ngữ pháp 3 |
| `N3-TO-V03` | `tong_on_bai_7.csv` | Từ vựng 3 |
| `N3-TO-G04` | `tong_on_bai_8.csv` | Ngữ pháp 4 |

Sửa đề N3: sửa CSV (hoặc `data/exams/N3/<MÃ>.json`) rồi:

```powershell
python -X utf8 tools/import_riki_csv_to_json.py
```
