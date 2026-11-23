# TestMark — Registro Prove e Monitoraggio Attività Studenti

Applicazione web per docenti ottimizzata per **tablet** e desktop, progettata per registrare rapidamente lo svolgimento di **compiti grafici**, **interrogazioni orali** e **consegne pratiche**, verificare i requisiti minimi per categoria e monitorare le carenze in tempo reale.

- **URL di pubblicazione (GitHub Pages):** https://adrianoruzza.github.io/TestMark/
- **Repository GitHub:** https://github.com/adrianoruzza/TestMark
- **Architettura:** 100% client-side (React + TypeScript + Vite + Tailwind CSS), senza backend né chiavi API.

## Funzionalità principali

- Gestione per classi indipendenti con selettore rapido e intestazioni fisse.
- Registrazione rapida in cella (**Svolto**, **Assente**, **Non svolto**, **Non registrato**) con tocco/clic, menu rapido diretto (`▾` o tasto destro) e scorciatoie (`S`, `A`, `N`, `Canc`).
- **UNDO / REDO** completo su tutte le modifiche ai dati (pulsanti nella barra superiore + `Ctrl+Z`, `Ctrl+Y`, `Ctrl+Shift+Z`).
- Configurazione dei requisiti minimi per categoria e controllo automatico dello stato di ogni studente.
- Inserimento manuale e importazione elenchi studenti da **Excel (`.xlsx`)**, **Word (`.docx`)** e **Testo (`.txt`)** con anteprima modificabile e filtro duplicati.
- Spostamento e copia di studenti tra classi con conservazione dello storico.
- **Resoconto** automatico delle carenze filtrabile, stampabile ed esportabile in Excel.
- Salvataggio automatico in `localStorage`, esportazione **Excel (`.xlsx`)** e **backup/ripristino completo (`.json`)**.

## Installazione e avvio locale

Prerequisiti: **Node.js 20+** e **npm**.

```bash
npm install
npm run dev
```

Comandi disponibili:

- `npm run dev` — Avvia il server di sviluppo locale su `http://localhost:3000/`.
- `npm run lint` — Esegue la verifica statica TypeScript (`tsc --noEmit`).
- `npm run build` — Compila la build di produzione in `dist/` con base path `/TestMark/`.
- `npm run preview` — Avvia un'anteprima locale della build di produzione all'indirizzo `http://localhost:4173/TestMark/`.

## Configurazione GitHub Pages (`/TestMark/`) e PWA

Il progetto è già predisposto per il deploy all'indirizzo esatto `https://adrianoruzza.github.io/TestMark/` e per l'installazione come **Progressive Web App (PWA)**:

- `vite.config.ts` imposta automaticamente `base: '/TestMark/'` in build/preview, genera `dist/manifest.webmanifest` (`start_url: '/TestMark/'`, `scope: '/TestMark/'`, `display: 'standalone'`), genera il Service Worker Workbox (`dist/sw.js`) con pulizia automatica delle cache obsolete e copia `dist/index.html` in `dist/404.html` per evitare errori 404.
- `public/` contiene `.nojekyll`, `favicon.ico`, `testmark-favicon-32-v2.png` (32×32), `testmark-apple-touch-icon-v2.png` (180×180), `testmark-icon-192-v2.png`, `testmark-icon-512-v2.png` e `testmark-icon-maskable-512-v2.png` (con safe-zone per Android).
- `.github/workflows/deploy-pages.yml` esegue automaticamente `npm run lint`, `npm run build` (con `VITE_BASE_PATH=/TestMark/`), verifica tutti gli artefatti statici e PWA e pubblica `dist/` su GitHub Pages a ogni push su `main`.

## Pubblicazione passo passo su GitHub

1. Accedi a GitHub con l'account **`adrianoruzza`** e crea un nuovo repository vuoto chiamato esattamente **`TestMark`** (senza README, `.gitignore` o licenza precompilati).
2. Dal terminale nella cartella del progetto esegui:
   ```bash
   git add .
   git commit -m "Predisposizione TestMark per GitHub Pages e PWA"
   git branch -M main
   git remote add origin https://github.com/adrianoruzza/TestMark.git
   git push -u origin main
   ```
   *(Se il remoto `origin` è già presente, usa `git remote set-url origin https://github.com/adrianoruzza/TestMark.git` prima del push.)*
3. Nel repository `adrianoruzza/TestMark` su GitHub apri **Settings → Pages**.
4. In **Build and deployment → Source** seleziona **GitHub Actions**.
5. Apri la scheda **Actions**: il workflow **Build e Deploy TestMark su GitHub Pages** partirà automaticamente (o può essere avviato manualmente con **Run workflow**).
6. Al termine del deploy, l'applicazione sarà attiva su **https://adrianoruzza.github.io/TestMark/**.

## Installazione come app (PWA)

Apri **https://adrianoruzza.github.io/TestMark/** dal browser del dispositivo:

- **Tablet e smartphone Android (Chrome / Edge):** tocca il pulsante discreto **Installa** nella barra superiore (oppure il menu `⋮` → *Installa app* / *Aggiungi a schermata Home*).
- **iPad e iPhone (Safari su iPadOS / iOS):** tocca il pulsante **Installa** nella barra superiore per le istruzioni rapide, oppure tocca direttamente **Condividi** nella barra di Safari → **Aggiungi alla schermata Home** → **Aggiungi**.
- **Desktop (Chrome / Edge):** clicca **Installa** nella barra superiore dell'app (oppure l'icona di installazione nella barra degli indirizzi).

### Funzionamento offline e aggiornamenti
- Dopo la prima apertura online, TestMark funziona anche **offline** (registrazione prove, UNDO/REDO, resoconto, import/export Excel e backup JSON) grazie al precaching Workbox degli asset statici.
- Quando viene pubblicata una nuova versione su GitHub Pages, l'app mostra un avviso discreto in basso a sinistra (**"Nuova versione disponibile — Aggiorna"**): l'aggiornamento ricarica solo il codice applicativo lasciando **intatti tutti i dati salvati in `localStorage`**.

## Privacy e sicurezza dei dati

- Nessuna credenziale o chiave API è presente nel codice sorgente.
- Tutti i dati degli studenti vengono salvati esclusivamente in `localStorage` nel browser del dispositivo (mai nella cache del Service Worker e mai inviati a server esterni).
- Il file `.gitignore` esclude automaticamente file `.env*`, chiavi/credenziali e file di elenchi/backup degli studenti (`*.xlsx`, `*.xls`, `*.docx`, `*.csv`, `registro-prove-backup-*.json`, `studenti*.txt`, `backups/`, `exports/`).
- Esegui periodicamente un **Backup completo (`.json`)** dalla sezione *Classi e Backup* per conservare una copia personale dei tuoi archivi o trasferirli tra dispositivi/browser diversi.
