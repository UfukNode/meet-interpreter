# Meet Tercüman Kurulum

Google Meet görüşmesinde karşı tarafı Türkçe duyarsın, o da seni İngilizce duyar. Bu rehber kurulumu ve ilk denemeyi adım adım anlatır.

## Gereksinimler

| Gereksinim | Açıklama |
| --- | --- |
| Chrome 116 veya üstü | Ya da Brave, Edge gibi Chromium tabanlı bir tarayıcı |
| Node.js 18 veya üstü | Eklentiyi derlemek için, bir kez |
| ElevenLabs API anahtarı | Ses tanıma ve ses üretimi. Ses klonlama için Starter veya üstü plan |
| Anthropic API anahtarı | Çeviriyi Claude yapar. Hesapta biraz kredi olmalı. Ücretsiz çeviri seçersen gerekmez |
| Kulaklık | Hoparlörden çıkan çeviri mikrofona geri girmesin diye |

## API anahtarları

1. **ElevenLabs:** elevenlabs.io, Developers, API Keys, Create. İzinlerde Text to Speech, Speech to Text ve Voices (yazma) açık olsun.
2. **Anthropic:** console.anthropic.com, API Keys, Create Key. Billing bölümünden kredi yükle.

## Kurulum

1. İndir ve derle:
   ```bash
   git clone https://github.com/UfukNode/meet-interpreter.git
   cd meet-interpreter
   npm install
   npm run build
   ```
2. Chrome'da `chrome://extensions` adresini aç, sağ üstten **Geliştirici modu**nu aç.
3. **Paketlenmemiş öğe yükle** düğmesine bas, `meet-interpreter` klasörünün içine gir ve `dist` klasörünü seç. `meet-interpreter` klasörünün kendisini seçersen Chrome manifest dosyasını bulamaz.
4. Araç çubuğundaki yapboz simgesinden Meet Tercüman'ı sabitle.
5. Arayüz İngilizce açılır. Türkçe için ayarlar sayfasının ya da açılır pencerenin sağ üstündeki **TR** düğmesine bas; bu rehberdeki düğme adları Türkçe arayüze göredir.
6. Açılan ayarlar sayfasında (açılmazsa simgeye sağ tık, Seçenekler):
   1. İki anahtarı yapıştır ve **Anahtarları test et** de.
   2. **Mikrofon iznini ver** de ve izin ver.
   3. **Benim sesim** bölümünde metni sessiz bir odada, normal sesinle 1 ile 2 dakika arası oku, **Bu kayıttan sesimi oluştur** de, sonra **Dinle** ile kontrol et.

## Ücretsiz çeviri

Anthropic anahtarı istemiyorsan Ayarlar > 6. Çeviri bölümünde **Çeviri modeli** olarak **Ücretsiz**'i seç.

1. **Ücretsiz çeviriyi hazırla** düğmesi görünüyorsa bir kez bas. Chrome dil paketini indirir, birkaç saniye sürer. Unutursan "Çeviriyi başlat" düğmesi de aynı işi yapar.
2. İstersen **Çeviri kalitesini artırın** bölümüne ücretsiz anahtarlar ekle. Hepsi isteğe bağlıdır:
   - **DeepL API Free:** deepl.com/pro-api. Ayda 500.000 karakter.
   - **Mistral:** console.mistral.ai. Ücretsiz planda Mistral metinleri varsayılan olarak model eğitiminde kullanır; konsoldaki gizlilik (Privacy) ayarından kapat.
   - **Groq:** console.groq.com. Kart gerekmez, günlük kotası küçüktür.
3. **Bu anahtarları test et** ile kontrol et.

Görüşmede eklenti en kaliteli servisle başlar (DeepL, sonra Mistral, sonra Groq), kotası dolan ya da yanıt vermeyen servisi atlar ve en son Chrome'un kendi çevirmenine geçer. Hangi servisin çevirdiği ekranda görünmez. Ses tanıma ve ses üretimi için ElevenLabs anahtarı yine gerekir.

## Görüşmede kullanım

1. Meet görüşmesine gir. Meet sekmesi eklentiyi kurmadan önce açıksa sekmeyi bir kez yenile (F5).
2. Eklenti simgesine tıkla:
   - **Karşı taraf konuşunca:** Sesli çeviri, Sadece altyazı ya da Kapalı.
   - **Ben konuşunca:** Sesli çeviri ya da Kapalı.
   - Karşı taraf onay verdiyse **Karşı taraf, sesinin klonlanmasına izin verdi** kutusunu işaretle. Yaklaşık 45 saniye konuşmasından sonra çeviriyi onun sesine yakın bir sesle duyarsın.
3. İstersen **Bu görüşmeyi kaydet** kutusunu işaretle: Meet sekmesinin görüntüsü ve iki tarafın sesi MP4 olarak kaydedilir, görüşme bitince Kayıtlar sayfası açılır. Kayıt yalnızca bu bilgisayarda kalır; karşı tarafa söyle.
4. **Çeviriyi başlat** de. Kısayol: Alt + Shift + T.
5. Sayfadaki panelde altyazıları, gecikmeyi ve harcanan kullanımı görürsün. Modları buradan da değiştirebilirsin. Karşı tarafın çevirisi ayrıca Meet penceresinin altında, Meet'in düğmelerinin hemen üstünde film altyazısı gibi görünür (Ayarlar'da "Altyazıyı Meet penceresinin altında göster" ile kapatılabilir).
6. Sesli çeviride yalnızca çeviriyi duyarsın, karşı tarafın asıl sesi kapalıdır (Ayarlar'daki iki kaydırıcıyla kısık olarak geri açabilirsin). Sadece altyazı modunda ve çeviri kapalıyken karşı tarafı normal duyarsın.
7. **Test sesi gönder** karşı tarafa kısa bir çan sesi yollar: duyuyorlarsa çevirin de onlara ulaşır.

## Tek başına deneme (iki cihazla)

1. Bilgisayarda Meet'te yeni bir toplantı aç, kulaklığı tak, eklentiyi başlat.
2. Telefonla aynı toplantıya katıl. Telefonun sesini kıs ya da telefona ayrı bir kulaklık tak.
3. Telefona İngilizce konuş ya da telefonda İngilizce bir video aç: bilgisayarda Türkçesini duyarsın.
4. Bilgisayarın mikrofonuna Türkçe konuş: telefonda İngilizcesini duyarsın.

## Kredi tasarrufu

- **Sadece altyazı** modu ses üretmez ve klon yapmaz; maliyetin en büyük kısmı ortadan kalkar.
- Meet'te mikrofonun uzun süre kapalıysa senin tarafının ses tanıması kendiliğinden kapanır.
- Ayarlarda Claude Haiku 5.5 hem en hızlı hem en ucuz çeviri modelidir.
- Panel, görüşme boyunca harcanan dakikayı, karakteri, tokenı ve tahmini tutarı gösterir.

## Sorun giderme

| Belirti | Çözüm |
| --- | --- |
| "Manifest dosyası eksik veya okunamıyor" | Proje klasörü seçilmiş. **İptal** de, **Paketlenmemiş öğe yükle** ile `meet-interpreter` içindeki `dist` klasörünü seç. |
| "Ücretsiz çeviri ilk kullanımda hazırlanmalı" | Ayarlar > Çeviri'de "Ücretsiz çeviriyi hazırla"ya bas ya da "Çeviriyi başlat"a tekrar bas. |
| "Meet sekmesini bir kez yenileyin" | Eklenti, sekme açıldıktan sonra kurulmuş. F5 ile yenile. |
| "Eklentinin mikrofon izni yok" | Ayarlar, Mikrofon iznini ver. |
| Karşı taraf beni duymuyor | Meet'te mikrofonun açık mı? Panelde "Meet sayfasına bir kez tıklayın" yazıyorsa sayfaya tıkla. "Test sesi gönder" ile dene. |
| Kendi çevirimi geri duyuyorum | Kulaklık kullan ya da Ayarlar'da Hoparlör modunu aç. |
| Gecikme fazla | Claude modelini Haiku 5.5 yap, sessizlik süresini 0,5 sn seç. |
| Ses tanıma yeniden bağlanıyor | İnternet bağlantısını kontrol et. Eklenti kendisi yeniden bağlanır; birkaç saniyelik kesintide aradaki konuşma kaybolmaz. |

## Komut satırı testleri

```bash
npm test            # birim testleri
npm run test:e2e    # eklentiyi Chromium'a yükler, sahte bir Meet görüşmesinde dener
npm run test:api    # gerçek API'leri dener ve gecikmeleri ölçer
npm run test:free   # DeepL, Mistral ve Groq'un ücretsiz planlarını gerçek anahtarlarla dener
```

`test:api` ve uçtan uca testin çeviri bölümü için anahtarları proje klasöründeki `.env` dosyasına yaz:

```text
ELEVENLABS_API_KEY=...
ANTHROPIC_API_KEY=...
```
