<div align="center">

<h1>🎧 MusicSest</h1>

<p><strong>Voto collaborativo in tempo reale su playlist musicali.</strong><br>
Il pubblico vota la prossima canzone.</p>

</div>

---

## 📖 Indice

- [Cos'è MusicSest](#cosè-musicsest)
- [Funzionalità](#-funzionalità)

---

## Cos'è MusicSest

**MusicSest** è una web app pensata per feste, serate fra amici, aule o qualsiasi contesto in cui si vuole condividere della musica.

Un utente (**master**) crea una sessione e carica una playlist. Gli altri utenti (**listener**) si uniscono alla sessione con un codice a 5 caratteri e votano la prossima canzone da riprodurre.

Quando il brano corrente finisce, **la canzone più votata parte da sola**. Il master mantiene sempre il controllo: può skippare, bloccare o riprendere la riproduzione.

---

## ✨ Funzionalità

- 🎛️ **Sessione con codice a 5 caratteri** — facile da condividere a voce o via link.
- 🎲 **Candidati casuali** — ad ogni cambio brano il server propone N candidati (configurabile da 3 a 15) estratti dalla playlist.
- 🗳️ **Voto singolo per utente** — si può cambiare voto o ritirarlo cliccando di nuovo.
- 🏁 **Auto-advance** — alla fine del brano, la canzone più votata parte automaticamente.
- ⚖️ **Gestione parità** — in caso di pari merito, scelta casuale tra i candidati a pari punteggio.
- 👑 **Controllo master** — solo il master può:
  - caricare la playlist,
  - avviare una traccia specifica o una casuale,
  - **skippare** al vincitore delle votazioni,
  - **bloccare** la traccia corrente (con ripresa dal punto esatto),
  - **riprendere** dopo un blocco.
- 🔍 **Ricerca nella playlist** — filtro live per titolo o artista.
- 🧑‍🤝‍🧑 **Lista partecipanti in tempo reale** — chi è nella stanza, chi è il master.
- 🔗 **Deep link** — `/?join=ABCDE` precompila il codice per l'ospite.
- 📱 **Responsive** — layout a due colonne che collassa su mobile.