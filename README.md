# Adivinha Quem 🟥🟦

O jogo de tabuleiro, para a equipa toda numa video call.

**A jogar em:** https://adivinha-quem-rk3r.onrender.com (plano grátis do Render: abre o link
um minuto antes da chamada para acordar o servidor).

Em cada ronda uma pessoa é o **guardião** e só ela vê a **pessoa secreta** (uma das 17
caras da equipa). Toda a gente pergunta à vez, em voz alta na chamada, só perguntas de sim
ou não. O guardião responde e regista Sim ou Não na app, para a resposta ficar no ecrã de
todos. Cada um baixa no seu tabuleiro as cartas que já não servem. Quem achar que sabe,
arrisca: acertou, ganha a ronda; errou, fica de fora e toda a gente fica a saber quem não é.

## Como se joga

1. Alguém cria uma sala e diz o código de 4 letras na chamada (ou manda o link de convite).
2. **3 a 20 pessoas** entram a partir dos seus computadores. Quem chegar a meio de uma
   ronda entra na mesma, no fim da ordem.
3. O anfitrião escolhe as regras na sala:
   - **Temporizador por pergunta**: sem, 30, 45 ou 60 segundos. Com temporizador, quem
     demorar é saltado. Sem temporizador, a equipa gere o ritmo na chamada.
   - **Voltas**: quantas vezes a ordem de perguntas dá a volta antes de o guardião ganhar
     (1, 2 ou 3).
4. Começa a ronda. A app sorteia o guardião (vai rodando, toda a gente guarda uma vez
   antes de alguém repetir) e a pessoa secreta.
5. Perguntas em voz alta, respostas registadas pelo guardião, cartas baixadas por cada um.
   O anfitrião e o guardião podem saltar quem não está a perguntar.
6. **Arriscar palpite**: toca numa carta e confirma.
   - Acertou: a ronda acaba, **+2 pontos**.
   - Errou: fica de fora até ao fim da ronda e o palpite errado aparece no ecrã de todos.
   - Se a ordem der as voltas todas, ou toda a gente errar, o guardião ganha: **+1 ponto**.
7. No fim, a app revela a pessoa secreta e mostra a tabela da sala. O anfitrião carrega em
   **Próxima ronda**. Os pontos acumulam enquanto a sala existir.
8. **✕ Terminar jogo** (canto superior direito, dois toques) manda toda a gente de volta à
   sala, sem perder os pontos.

As caras do tabuleiro estão em `people.js` e as fotos em `public/fotos/<chave>.jpg`. Para
mudar a equipa, mexe nos dois.

## Correr localmente

```bash
npm install
npm start
# abre http://localhost:3000
```

Quem estiver na mesma rede entra em `http://<o-teu-ip-local>:3000`.

## Pôr na internet

A app é um único processo Node (Express + WebSockets na mesma porta), por isso qualquer
alojamento de Node serve. Respeita a variável `PORT`.

**Render** (o plano grátis chega), igual ao Imposter Draw:

1. Mete esta pasta num repositório no GitHub:
   ```bash
   git init
   git add .
   git commit -m "Adivinha Quem"
   git branch -M main
   git remote add origin https://github.com/<a-tua-conta>/adivinha-quem.git
   git push -u origin main
   ```
2. Render → New → Web Service → liga o repositório. O `render.yaml` já traz a configuração
   (build `npm install`, start `npm start`).
3. Quando acabar, partilha o URL. Fim.

**Railway / Fly.io** funcionam da mesma forma (`npm start`, porta em `$PORT`).

Nota: as salas vivem na memória do servidor. Um redeploy ou reinício termina os jogos a
decorrer, e no plano grátis do Render o servidor adormece após uns minutos sem uso, por
isso abre o link um minuto antes da chamada para o acordar.

## Testes

Com o servidor a correr noutra janela (o `GUARDIAN_GRACE_MS` curto é só para o teste
do guardião que perde a ligação; por defeito são 20 segundos):

```bash
GUARDIAN_GRACE_MS=600 PORT=3100 npm start
node test/sim.mjs 3100
```

Simula 8 pessoas por WebSocket: sala, regras, guardião, respostas, cartas, palpites
certos e errados, rotação do guardião, voltas esgotadas, temporizador, entrada a meio da
ronda, toda a gente a errar, e o guardião a perder a ligação (volta a tempo ou não).

Para experimentar à mão sem equipa, enche uma sala com bots:

```bash
node test/bots.mjs 3100 CODIGO Marta Bruno Daniel
```

## Tecnologia

- `server.js`: Express + `ws`. Estado do jogo no servidor, códigos de sala, rotação do
  guardião, temporizador opcional, pontos, tokens de reconexão.
- `public/`: cliente em JavaScript simples. Tabuleiro de cartas que viram, vista do
  guardião, ordem das perguntas, registo das respostas.
- Sem base de dados, sem build.
