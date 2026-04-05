const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

const CONFIG = {
  email: {
    to: 'sertavciya72@gmail.com',
    from: 'sertavciya72@gmail.com',
    appPassword: 'termlhmzrrrzumbc'
  },
  checkIntervalMs: 1 * 60 * 1000,
  delayThresholdMin: 60,
  lounge: {
    url: 'https://wingscard.smartdelay.com/wingscard/validation/validate-eligibility',
    cardPrefix: '524347',
    passengers: [
      { title: 'Bay',   firstName: 'Sertav Ciya', lastName: 'Timurtas' },
      { title: 'Bayan', firstName: 'Helin Giris',  lastName: 'Timurtas' }
    ],
    email: 'sertavciya72@gmail.com',
    phone: '+4915225268817'
  }
};

const alreadyNotified = new Set();
let loungeRegistered = false;

function parseIso(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

async function screenshot(page, name) {
  const file = `/Users/giris/flight-monitor/adim-${name}-${Date.now()}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  [LOUNGE] Screenshot: adim-${name}`);
}

async function fillPassenger(page, index, passenger) {
  // index=0 ilk yolcu, index=1 ikinci yolcu
  // Cinsiyet select veya radio
  const selects = page.locator('select');
  if (await selects.count() > index) {
    await selects.nth(index).selectOption(passenger.title).catch(() => {});
  }

  // Ad ve Soyad inputlari - her yolcu icin ayri bir grup var
  // Her yolcu grubu icin 2 text input: [ad, soyad]
  // Sadece metin inputlarini al (tarih/ucus numarasi haric)
  const textInputs = page.locator('input[type="text"], input:not([type]):not([placeholder*="GG"]):not([placeholder*="gg"])');
  const count = await textInputs.count();
  const adIndex   = index * 2;
  const soyadIndex = index * 2 + 1;
  if (count > adIndex)    await textInputs.nth(adIndex).fill(passenger.firstName);
  if (count > soyadIndex) await textInputs.nth(soyadIndex).fill(passenger.lastName);
}

async function registerLounge(flight) {
  console.log(`  [LOUNGE] Kayit baslatiliyor: ${flight.flightNo} (${flight.flightDate})...`);

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  try {
    // ADIM 1 - Kart dogrulama
    await page.goto(CONFIG.lounge.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);
    await screenshot(page, '1-kart');

    await page.locator('input').first().fill(CONFIG.lounge.cardPrefix);
    await page.locator('button').filter({ hasText: /devam|ileri|doğrula/i }).first().click();
    await page.waitForTimeout(2500);

    // ADIM 2 - Kaydol
    await page.locator('button, a').filter({ hasText: /kaydol/i }).first().click();
    await page.waitForTimeout(2500);
    await screenshot(page, '2-ucus-formu');

    // ADIM 3 - Ucus detaylari: DIREKT tarih + ucus numarasi doldur
    console.log('  [LOUNGE] Tarih alani dolduruluyor...');
    const dateInput = page.locator('input[placeholder*="GG"], input[placeholder*="gg"]').first();

    // Takvim acilmadan once alana tikla
    await dateInput.click();
    await page.waitForTimeout(1500);
    await screenshot(page, '3-takvim-acik');

    // Klavye ile gg/aa/yyyy formatinda yaz
    // Cogu masked input: gun yaz -> otomatik ay'a gec -> ay yaz -> yil
    const [dd, mm, yyyy] = flight.flightDate.split('.');
    await page.keyboard.type(dd + '.' + mm + '.' + yyyy); // "02.04.2026"
    await page.waitForTimeout(600);

    // Kontrol et - hala bossa farkli yontem dene
    const dateVal = await dateInput.inputValue().catch(() => '');
    console.log(`  [LOUNGE] Tarih degeri: "${dateVal}"`);

    if (!dateVal || dateVal.includes('G') || dateVal.includes('A') || dateVal.trim() === '') {
      // Takvim acik olabilir - once kapat
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      // React/Vue setter ile doldur
      await page.evaluate((val) => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const target = inputs.find(i => i.placeholder &&
          (i.placeholder.toLowerCase().includes('gg') || i.placeholder.toLowerCase().includes('aa')));
        if (!target) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(target, val);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        target.dispatchEvent(new Event('blur', { bubbles: true }));
      }, flight.flightDate);
      await page.waitForTimeout(800);
    }

    // Takvim hala aciksa kapat
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await screenshot(page, '4-tarih-sonrasi');

    // Ucus numarasi
    console.log('  [LOUNGE] Ucus numarasi dolduruluyor...');
    const flightInput = page.locator('input').nth(1);
    await flightInput.click();
    await page.waitForTimeout(400);
    await flightInput.fill(flight.flightNo.replace(/\s+/g, ''));
    await page.waitForTimeout(600);
    await screenshot(page, '5-ucus-detay-dolu');

    // Ucus detaylari Devam
    await page.locator('button').filter({ hasText: /devam/i }).first().click();

    // Yolcu sayfasinin yuklenmesini bekle - "Unvan" veya "Isim" gorunene kadar
    await page.waitForSelector('text=/unvan|isim|yolcu/i', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await screenshot(page, '6-yolcu-sayfasi');

    // ADIM 4 - Yolcu bilgileri sayfasi (Unvan* + Isim* + Soyisim*)
    await screenshot(page, '6b-yolcu-sayfasi-detay');

    // Unvan dropdown ac ve sec - PrimeNG p-select icin
    // id="title_1-input" ilk yolcu, id="title_2-input" ikinci yolcu
    async function selectUnvan(passengerIndex, title) {
      const comboId = `title_${passengerIndex + 1}-input`;
      console.log(`  [LOUNGE] Unvan seciliyor: #${comboId} -> ${title}`);

      // Combobox'a tikla
      await page.locator(`#${comboId}`).click();
      await page.waitForTimeout(800);

      // Acilan listbox'tan secim yap
      const options = page.locator('[role="option"]').filter({ hasText: new RegExp(`^${title}$`, 'i') });
      const cnt = await options.count();
      console.log(`  [LOUNGE] Option sayisi: ${cnt}`);
      if (cnt > 0) {
        await options.first().click();
      }
      await page.waitForTimeout(500);
    }

    // Ilk yolcu: Bay Sertav Ciya Timurtas
    await selectUnvan(0, 'Bay');
    await page.locator('input[type="text"]').nth(0).click();
    await page.locator('input[type="text"]').nth(0).fill(CONFIG.lounge.passengers[0].firstName);
    await page.waitForTimeout(300);
    await page.locator('input[type="text"]').nth(1).click();
    await page.locator('input[type="text"]').nth(1).fill(CONFIG.lounge.passengers[0].lastName);
    await page.waitForTimeout(500);

    // Arti (+) butonuna tikla - sag altta
    console.log('  [LOUNGE] Arti (+) butonuna basilıyor...');

    // Ek Yolcu + butonuna tikla (id="sd-addButton", aria-label="Yolcu ekle")
    console.log('  [LOUNGE] sd-addButton aranıyor...');
    await page.locator('#sd-addButton button, button[aria-label="Yolcu ekle"], button.sd-add-button').first().click();
    console.log('  [LOUNGE] + tiklandı');

    await page.waitForTimeout(1500);
    await screenshot(page, '7-es-ekleme-formu');
    console.log('  [LOUNGE] Ek Yolcu tiklandi, screenshot alindi');

    // Ikinci yolcu: Bayan Helin Giris Timurtas
    // + tiklandi, yeni satir acildi - once text input sayisini kontrol et
    const cntBefore = await page.locator('input[type="text"]').count();
    console.log(`  [LOUNGE] + oncesi text input sayisi: ${cntBefore}`);

    // Eger sayfa yenilenmemisse scroll down yap ve bekle
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(800);

    const cntAfter = await page.locator('input[type="text"]').count();
    console.log(`  [LOUNGE] + sonrasi text input sayisi: ${cntAfter}`);

    console.log('  [LOUNGE] 2. yolcu unvani seciliyor...');
    await selectUnvan(1, 'Bayan');
    console.log('  [LOUNGE] Bayan secildi, isim dolduruluyor...');

    // Son iki text inputu doldur (yeni eklenen satirdaki alanlar)
    const allTxt = page.locator('input[type="text"]');
    const cnt = await allTxt.count();
    console.log(`  [LOUNGE] Toplam text input: ${cnt}`);

    // Her input degerini logla
    const inputVals = await page.evaluate(() =>
      [...document.querySelectorAll('input[type="text"]')].map((el, i) => `${i}: "${el.value}" [${el.placeholder}]`)
    );
    console.log('  [LOUNGE] Mevcut input degerleri:', inputVals.join(', '));

    await allTxt.nth(cnt - 2).click();
    await allTxt.nth(cnt - 2).fill('');
    await allTxt.nth(cnt - 2).fill(CONFIG.lounge.passengers[1].firstName);
    console.log('  [LOUNGE] Isim dolduruldu: ' + CONFIG.lounge.passengers[1].firstName);
    await page.waitForTimeout(300);
    await allTxt.nth(cnt - 1).click();
    await allTxt.nth(cnt - 1).fill('');
    await allTxt.nth(cnt - 1).fill(CONFIG.lounge.passengers[1].lastName);
    console.log('  [LOUNGE] Soyisim dolduruldu: ' + CONFIG.lounge.passengers[1].lastName);
    await page.waitForTimeout(500);
    await screenshot(page, '8-yolcular-tamam');

    // Yolcu sayfasi Devam
    await page.locator('button').filter({ hasText: /devam/i }).first().click();
    await page.waitForTimeout(2500);
    await screenshot(page, '9-iletisim');

    // ADIM 5 - Iletisim bilgileri (email x2 + telefon)
    // Sayfa yuklenmesini bekle
    await page.waitForTimeout(2000);

    // Sayfadaki input bilgilerini logla
    const contactInputInfo = await page.evaluate(() =>
      [...document.querySelectorAll('input')].map((el, i) => ({
        i, type: el.type, placeholder: el.placeholder, id: el.id, name: el.name, val: el.value
      }))
    );
    console.log('  [LOUNGE] Iletisim inputlari:', JSON.stringify(contactInputInfo));

    // Tum inputlari al ve sirayla doldur: email, email confirm, telefon
    const allInputs = page.locator('input');
    const inputCount = await allInputs.count();
    console.log(`  [LOUNGE] Toplam input sayisi: ${inputCount}`);

    if (inputCount >= 1) await allInputs.nth(0).fill(CONFIG.lounge.email);
    if (inputCount >= 2) await allInputs.nth(1).fill(CONFIG.lounge.email);

    // Telefon: once ulke kodu dropdown'i ac (+49 / Almanya sec), sonra numara yaz
    console.log('  [LOUNGE] Ulke kodu dropdown aciliyor...');
    await page.locator('#areaCode span[role="combobox"], #sd-areaCodeBody span[role="combobox"]').first().click();
    await page.waitForTimeout(1000);

    // +49 veya Almanya secenegini bul
    const areaOptions = page.locator('[role="option"]');
    const areaOptCount = await areaOptions.count();
    console.log(`  [LOUNGE] Alan kodu option sayisi: ${areaOptCount}`);

    // +49 veya Germany/Deutschland iceren secenegi bul
    const germanyOpt = areaOptions.filter({ hasText: /\+49|germany|deutschland|alman/i });
    if (await germanyOpt.count() > 0) {
      await germanyOpt.first().click();
      console.log('  [LOUNGE] +49 Almanya secildi');
    } else if (areaOptCount > 0) {
      // Listeden +49 ara
      for (let i = 0; i < Math.min(areaOptCount, 50); i++) {
        const txt = await areaOptions.nth(i).textContent();
        if (txt && txt.includes('+49')) {
          await areaOptions.nth(i).click();
          console.log('  [LOUNGE] +49 bulundu ve secildi:', txt.trim());
          break;
        }
      }
    }
    await page.waitForTimeout(500);

    // Telefon numara alanini doldur (ulke kodu olmadan)
    const phoneNumber = CONFIG.lounge.phone.replace(/^\+49/, '').replace(/^\+/, '');
    console.log(`  [LOUNGE] Telefon numarasi: ${phoneNumber}`);
    await page.locator('#phoneNumber-input').fill(phoneNumber);
    await page.waitForTimeout(500);
    await screenshot(page, '9-iletisim-dolu');

    await page.locator('button').filter({ hasText: /devam/i }).first().click();
    await page.waitForTimeout(2500);
    await screenshot(page, '10-ozet');

    // ADIM 5 - Onayla
    await page.locator('button').filter({ hasText: /onayla/i }).first().click();
    await page.waitForTimeout(5000);
    await screenshot(page, '11-son');

    loungeRegistered = true;
    console.log(`  [LOUNGE] KAYIT TAMAMLANDI! Lounge hakki alindi.`);

  } catch (err) {
    await page.screenshot({ path: `/Users/giris/flight-monitor/lounge-hata-${Date.now()}.png`, fullPage: true });
    console.error(`  [LOUNGE] Hata: ${err.message}`);
  } finally {
    await browser.close();
  }
}

async function sendEmail(delayedFlights) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: CONFIG.email.from, pass: CONFIG.email.appPassword }
  });

  const lines = delayedFlights.map(f =>
    `• ${f.flightNo} → ${f.destination} | Planlanan: ${f.scheduled} | Beklenen: ${f.expected} | Gecikme: ~${f.delayMin} dk`
  ).join('\n');

  await transporter.sendMail({
    from: CONFIG.email.from,
    to: CONFIG.email.to,
    subject: `GVA Havalimani Rotar Uyarisi - ${delayedFlights.length} ucak gecikmeli`,
    text: `Cenevre GVA Havalimani'ndan kalkan asagidaki ucaklarda 1 saatten fazla gecikme tespit edildi:\n\n${lines}\n\nNot: Senin ucusun 5 Nisan 20:55 GVA -> BER`
  });

  console.log(`[${new Date().toLocaleTimeString()}] Mail gonderildi: ${delayedFlights.length} gecikmeli ucus`);
}

async function checkFlights() {
  console.log(`[${new Date().toLocaleTimeString()}] Kontrol ediliyor...`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let allFlights = [];

  // GVA: POST /api/v1/data/flights
  await page.route('**/api/v1/data/flights**', async (route) => {
    try {
      const response = await route.fetch({ timeout: 60000 });
      try {
        const body = await response.text();
        const data = JSON.parse(body);
        const batch = Array.isArray(data)
          ? data
          : (data.data || data.flights || data.results || data.items || []);
        if (batch.length > 0) allFlights = allFlights.concat(batch);
        // Ilk cevapta alan adlarini log'a yaz (debug icin)
        if (allFlights.length > 0 && allFlights.length <= batch.length) {
          console.log('  [DEBUG] Ornek ucus alanlari:', Object.keys(allFlights[0]).join(', '));
          // Ilk 3 ucusun tarih/saat degerlerini goster
          allFlights.slice(0, 3).forEach((f, i) => {
            console.log(`  [DEBUG] Ucus ${i}: SchedDate=${f.DepartureScheduledDate} SchedTime=${f.DepartureScheduledTime} ExpDate=${f.DepartureExpectedDate} ExpTime=${f.DepartureExpectedTime} Delay=${f.Delay} Name=${f.Name}`);
          });
        }
      } catch (_) {}
      await route.fulfill({ response });
    } catch (_) { await route.abort(); }
  });

  try {
    // 5 Nisan ucuslari
    await page.goto('https://www.gva.ch/en/Site/Passagers/Vols/Informations/Departs?date=639109440000000000', {
      waitUntil: 'networkidle',
      timeout: 60000
    });
    await page.waitForTimeout(4000);

    await page.waitForTimeout(1000);
    console.log(`  GVA: ${allFlights.length} ucus`);

    const delayed = [];
    const windowStart = new Date('2026-04-04T17:55:00+02:00');
    const windowEnd   = new Date('2026-04-05T20:55:00+02:00');

    // Ucus numarasini normalize et: EJU/EZS/U2 -> EZY (EasyJet), vs.
    function normalizeFlightNo(no) {
      if (!no) return '?';
      no = no.replace(/\s+/g, '');
      if (no.startsWith('EJU') || no.startsWith('EZS')) return 'EZY' + no.slice(3);
      if (no.startsWith('U2'))  return 'EZY' + no.slice(2);
      if (no.startsWith('FR'))  return 'RYR' + no.slice(2);
      if (no.startsWith('W6'))  return 'WZZ' + no.slice(2);
      return no;
    }

    function gvaToIso(dateStr, timeStr) {
      if (!dateStr || !timeStr) return null;
      const p = dateStr.split('.');
      if (p.length !== 3) return null;
      return `${p[2]}-${p[1]}-${p[0]}T${timeStr}:00+02:00`;
    }

    function addDelayed(flightNo, dest, scheduled, expected) {
      if (!flightNo || !scheduled || !expected) return;
      if (scheduled < windowStart || scheduled > windowEnd) return;
      const delayMin = Math.round((expected - scheduled) / 60000);
      if (delayMin < CONFIG.delayThresholdMin) return;
      const key = `${flightNo}-${scheduled.toISOString()}`;
      if (alreadyNotified.has(key)) return;
      const dd   = String(scheduled.getDate()).padStart(2, '0');
      const mm   = String(scheduled.getMonth() + 1).padStart(2, '0');
      const yyyy = scheduled.getFullYear();
      delayed.push({
        flightNo, destination: dest,
        scheduled: scheduled.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
        expected:  expected.toLocaleTimeString('tr-TR',  { hour: '2-digit', minute: '2-digit' }),
        delayMin,
        flightDate:    `${dd}.${mm}.${yyyy}`,
        flightDateISO: `${yyyy}-${mm}-${dd}`
      });
      alreadyNotified.add(key);
    }

    // GVA kaynaği
    for (const f of allFlights) {
      const status = (f.Status || '').toLowerCase();
      if (status.includes('cancel')) continue;
      const scheduled = parseIso(gvaToIso(f.DepartureScheduledDate, f.DepartureScheduledTime));
      const expected  = parseIso(gvaToIso(
        f.DepartureExpectedDate || f.DepartureScheduledDate,
        f.DepartureExpectedTime || f.DepartureScheduledTime
      ));
      const flightNo = normalizeFlightNo(f.Name || '?');
      addDelayed(flightNo, f.Destination || '?', scheduled, expected);
    }

    // AirLabs verisini once cek (FR24 ve AirLabs bloklari icin ortak kullanim)
    let alFlightsForRef = [];
    try {
      const alRef = await page.evaluate(async (key) => {
        const r = await fetch(`https://airlabs.co/api/v9/schedules?dep_iata=GVA&api_key=${key}`);
        return r.text();
      }, 'ab83db75-4f1e-45ad-8a57-586dd15c1651');
      alFlightsForRef = (JSON.parse(alRef)).response || [];
    } catch(_) {}

    // FR24 kaynaği (gercek zamanli, API key gerektirmez)
    try {
      const fr24Page = await browser.newPage();
      let fr24Flights = [];

      const fr24RespPromise = fr24Page.waitForResponse(
        resp => resp.url().includes('/api/v1/airports/1277/departures'),
        { timeout: 40000 }
      );

      fr24Page.goto('https://www.flightradar24.com/airport/gva/departures', {
        waitUntil: 'commit', timeout: 40000
      }).catch(() => {});

      const fr24Resp = await fr24RespPromise;
      const fr24Json = JSON.parse(await fr24Resp.text());
      fr24Flights = fr24Json.data || [];
      await fr24Page.close();

      console.log(`  FR24: ${fr24Flights.length} ucus`);

      for (const f of fr24Flights) {
        const status = (f.status?.name || '').toLowerCase();
        if (status.includes('cancel')) continue;
        const scheduled = f.scheduledTime ? new Date(f.scheduledTime * 1000) : null;
        const expected  = f.estimatedTime ? new Date(f.estimatedTime * 1000) : scheduled;

        // FR24 IATA numarasini AirLabs ICAO numarasiyla eslestir (scheduled time ±3 dk)
        const alMatch = alFlightsForRef.find(al => {
          const alSched = parseIso((al.dep_time || '').replace(' ', 'T') + ':00+02:00');
          return alSched && scheduled && Math.abs(alSched - scheduled) <= 3 * 60000
            && (al.flight_iata || '').replace(/\s+/g,'') === (f.flight?.number || '').replace(/\s+/g,'');
        });
        const flightNo = alMatch
          ? normalizeFlightNo(alMatch.flight_icao || alMatch.flight_iata || f.flight?.number || '?')
          : normalizeFlightNo(f.flight?.number || '?');

        addDelayed(flightNo, f.destination || '?', scheduled, expected);
      }
    } catch (e) {
      console.log('  FR24 hatasi:', e.message);
    }

    // AirLabs kaynaği (3. kaynak - FR24 bloğunda çekildi, tekrar kullan)
    try {
      const alFlights = alFlightsForRef;
      console.log(`  AirLabs: ${alFlights.length} ucus`);

      for (const f of alFlights) {
        if ((f.status || '').toLowerCase().includes('cancel')) continue;
        const depTime = f.dep_time || f.dep_estimated || '';
        if (!depTime) continue;
        const scheduled = parseIso(depTime.replace(' ', 'T') + ':00+02:00');
        const delayMin  = Number(f.delayed || 0);
        if (!scheduled || delayMin < CONFIG.delayThresholdMin) continue;
        if (scheduled < windowStart || scheduled > windowEnd) continue;
        const expected = new Date(scheduled.getTime() + delayMin * 60000);
        const flightNo = normalizeFlightNo(f.flight_icao || f.flight_iata || '?');
        addDelayed(flightNo, f.arr_iata || '?', scheduled, expected);
      }
    } catch (e) {
      console.log('  AirLabs hatasi:', e.message);
    }

    if (delayed.length > 0) {
      console.log(`  ${delayed.length} gecikmeli ucus bulundu.`);
      delayed.forEach(f => console.log(`    ${f.flightNo} -> ${f.destination} (+${f.delayMin} dk)`));

      if (!loungeRegistered) {
        await registerLounge(delayed[0]);
      }

      await sendEmail(delayed);
    } else {
      console.log(`  Rotar yok.`);
    }

  } catch (err) {
    console.error('  Hata:', err.message);
  } finally {
    await browser.close();
  }
}

async function main() {
  const now = new Date();
  console.log(`Baslatildi: ${now.toLocaleString()}`);
  console.log(`Izleme penceresi: 4 Nisan 17:55 - 5 Nisan 20:55`);
  console.log(`Kontrol araligi: 1 dakika`);
  console.log(`Durdurmak icin: Ctrl+C\n`);

  await checkFlights();

  setInterval(async () => {
    await checkFlights();
  }, CONFIG.checkIntervalMs);
}

// TEST: Sadece lounge kaydini test etmek icin
// node monitor.js --test
if (process.argv.includes('--test')) {
  registerLounge({
    flightNo: 'EZY2184',
    destination: 'Berlin',
    flightDate: '05.04.2026',
    flightDateISO: '2026-04-05',
    scheduled: '18:00',
    expected: '19:10',
    delayMin: 70
  }).catch(console.error);
} else {
  main().catch(console.error);
}
