# tools/audit

Uygulamayi acmadan, SSH kurmadan ve kullanici config'ine dokunmadan kosan
denetim takimi. Kod okuyup "sorun yok" demek yerine gercek fonksiyonu
dusmanca girdiyle CALISTIRIR.

```bash
npm run audit
```

- `harness.js` — gercek `main.js`'i yukler, `electron`'u sahteler
  (`app.getPath('userData')` gecici klasore gider), 57 IPC handler'i yakalar.
  Hicbir ag baglantisi kurulmaz, hicbir kullanici dosyasi yazilmaz.
- `check.js` — kontroller. `grab(dosya, fn, ...bagimliliklar)` modul-duzeyi bir
  fonksiyonu sutun-0 kapanis ayracina kadar kesip tek basina calistirilabilir yapar,
  boylece disari acilmayan ic fonksiyonlar da test edilebilir.

Yeni kontrol eklerken: once HATAYI URETEN girdiyi yaz ve kirmizi gordugunu
dogrula, sonra duzelt. Yesil baslayan bir kontrol hicbir sey kanitlamaz.

2026-09-22'de bulundugu 5 hata icin commit `aab3036`.
