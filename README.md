# Registro Prove — Monitoraggio Attività Studenti

Applicazione web pensata per i docenti per registrare lo svolgimento di **compiti grafici**, **interrogazioni orali** e **consegne pratiche**, verificare automaticamente il raggiungimento dei requisiti minimi per categoria e consultare il resoconto delle carenze in tempo reale.

L'applicazione funziona **interamente nel browser** (nessun server backend, nessun database remoto, nessuna chiave API richiesta).

## Funzionalità principali

- Gestione per classi indipendenti con selettore rapido.
- Tabella registro con intestazioni cronologiche fisse, colonna studenti bloccata a sinistra e riepilogo requisiti a destra.
- Registrazione rapida in cella: **Svolto**, **Assente**, **Non svolto**, **Non registrato** (clic rapido, menu diretto con tasto destro e scorciatoie `S`, `A`, `N`, `Canc`).
- Configurazione del numero minimo di prove richieste per ogni categoria e verifica automatica.
- Inserimento manuale studenti e importazione da **Excel (`.xlsx`)**, **Word (`.docx`)** e **Testo (`.txt`)** con anteprima modificabile e controllo duplicati.
- Spostamento e copia di studenti tra classi con conservazione dello storico.
- Vista **Resoconto** con filtri per classe, stato e categoria, stampa ed esportazione Excel.
- Salvataggio automatico in `localStorage`, esportazione **Excel (`.xlsx`)** e **backup/ripristino completo (`.json`)**.

## Avvio in locale

```bash
npm install
npm run dev
```

Comandi principali:

- `npm run dev` — Avvia il server di sviluppo sulla porta `3000`.
- `npm run lint` — Esegue la verifica statica TypeScript (`tsc --noEmit`).
- `npm run build` — Genera il bundle di produzione nella cartella `dist/`.
- `npm run preview` — Avvia l'anteprima locale della build di produzione.

## Pubblicazione su GitHub e GitHub Pages

Il progetto è predisposto per funzionare sia su dominio radice sia in un sottopercorso GitHub Pages (`https://<utente>.github.io/<nome-repository>/`) grazie ai percorsi relativi generati in fase di build (`vite.config.ts`) e al workflow automatico in `.github/workflows/deploy-pages.yml`.

### Passaggi su GitHub

1. Crea un nuovo repository su GitHub (ad esempio `registro-prove`).
2. Collega il repository locale ed esegui il push sul branch `main`:
   ```bash
   git add .
   git commit -m "Prima pubblicazione Registro Prove"
   git branch -M main
   git remote add origin https://github.com/<TUO-UTENTE>/<NOME-REPO>.git
   git push -u origin main
   ```
3. Su GitHub apri **Settings → Pages**:
   - In **Build and deployment → Source** seleziona **GitHub Actions**.
4. A ogni push sul branch `main` (o tramite avvio manuale nella scheda **Actions**), GitHub eseguirà `npm run lint`, `npm run build` e pubblicherà automaticamente la cartella `dist/` su GitHub Pages.

## Privacy e gestione dei dati degli studenti

- Tutti i dati inseriti nell'app rimangono esclusivamente nel browser del docente (`localStorage`) e non vengono inviati a server esterni.
- **Non caricare mai nel repository GitHub** file `.xlsx`, `.docx`, `.csv` o backup `.json` contenenti dati reali degli studenti: il file `.gitignore` esclude già questi formati per prevenire caricamenti accidentali.
- Poiché `localStorage` è legato al dominio/origine del browser (es. `https://<utente>.github.io`), esegui periodicamente un **Backup completo (`.json`)** dalla sezione *Classi e Backup* per conservare una copia di sicurezza o trasferire i dati su un altro dispositivo.
