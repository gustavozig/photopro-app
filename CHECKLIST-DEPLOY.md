# Checklist para colocar o PhotoPRO no ar de verdade

O código já está pronto (IA + Mercado Pago + site). Faltam só as contas e chaves,
que só você pode criar. Siga na ordem.

## 1. Conta OpenAI (gera as fotos)

1. Crie uma conta em https://platform.openai.com
2. Adicione um método de pagamento em Settings → Billing (a API só funciona com
   crédito pré-pago ou cartão cadastrado).
3. Vá em https://platform.openai.com/api-keys e clique em "Create new secret key".
4. Copie a chave (começa com `sk-...`). Você só consegue ver ela uma vez.
5. Guarde essa chave — ela vai para a variável `OPENAI_API_KEY` no passo 4.

Custo esperado: ~US$0,04 por foto gerada (bem menos que os R$9,90 cobrados).

## 2. Conta Mercado Pago (recebe o pagamento)

1. Crie ou acesse sua conta em https://www.mercadopago.com.br
2. Acesse o painel de desenvolvedores: https://www.mercadopago.com.br/developers/panel
3. Crie uma aplicação (qualquer nome, ex: "PhotoPRO").
4. Dentro da aplicação, vá em "Credenciais de produção" e copie o **Access Token**
   (começa com `APP_USR-...`). Essa vai para `MP_ACCESS_TOKEN`.
5. Ainda no painel, procure a seção de **Webhooks / Notificações** e configure uma
   notificação para o evento "Pagamentos". A URL você só vai ter depois do passo 3
   (quando o Railway te der o endereço do site) — pode voltar aqui depois.
6. Quando configurar o webhook, o Mercado Pago mostra uma **chave secreta de
   assinatura** — copie ela para `MP_WEBHOOK_SECRET`.

## 3. Hospedagem no Railway

Escolhido no lugar do plano gratuito do Render porque o Railway não "dorme" —
o site fica sempre no ar, sem aquele atraso de 30-60s na primeira visita do
dia. Custo aproximado: US$5/mês (plano Hobby, já inclui US$5 de uso).

1. Crie uma conta em https://railway.com (dá para entrar com GitHub).
2. Suba a pasta `photopro-app` (a que contém `server.js`, `package.json`, etc.)
   para um repositório no GitHub — se não tiver Git instalado, me avise que eu te
   ajudo a criar o repositório e subir os arquivos.
3. No Railway, clique em "New Project" → "Deploy from GitHub repo" e selecione
   esse repositório. O Railway detecta que é um projeto Node.js e configura o
   build automaticamente (`npm install` + `npm start`) — não precisa mexer em
   Build/Start Command.
4. Vá na aba "Variables" do serviço e adicione as variáveis (uma por vez):
   - `OPENAI_API_KEY` → a chave do passo 1
   - `MP_ACCESS_TOKEN` → a chave do passo 2
   - `MP_WEBHOOK_SECRET` → a chave do passo 2 (pode deixar em branco por enquanto
     e voltar depois)
   - `PUBLIC_URL` → deixe em branco por enquanto, você só vai ter essa URL depois
     do passo 6
   - `PRICE_BRL` → `9.90`
5. Nas configurações do serviço ("Settings" → "Networking"), clique em
   **"Generate Domain"** para gerar uma URL pública tipo
   `https://photopro-app.up.railway.app`. Copie essa URL.
6. Volte em "Variables" e preencha `PUBLIC_URL` com essa URL (sem barra no
   final). Salvar reinicia o serviço automaticamente com a nova variável.
7. Volte no painel do Mercado Pago (passo 2.5) e finalize a configuração do
   webhook usando `https://SEU-APP.up.railway.app/api/webhooks/mercadopago`
   como URL de notificação. Copie a chave secreta gerada para
   `MP_WEBHOOK_SECRET` no Railway (se ainda não tiver feito).

## 4. Teste antes de divulgar

**Importante: a arquitetura só gera a foto DEPOIS do pagamento confirmado.**
Antes de pagar, nenhuma chamada à OpenAI acontece — a tela de "processamento"
é só alguns segundos de preparação visual, e a prévia da oferta é uma imagem
ilustrativa genérica (não é o seu resultado real). Isso é proposital: evita
gastar créditos de IA com quem ainda não pagou.

1. Abra a URL do Railway no navegador.
2. Envie uma selfie sua, escolha um estilo e deixe a fricção rodar até o fim
   (dura uns 4 minutos de propósito — é a etapa de percepção de valor. Nenhuma
   chamada à OpenAI acontece aqui, só a validação da selfie no servidor).
3. Na tela de oferta, confira se a prévia genérica com marca d'água aparece
   (ela é sempre a mesma imagem ilustrativa, não muda conforme sua selfie).
4. Clique em "Desbloquear em HD" e pague os R$9,90 de verdade (ou peça pra
   alguém de confiança pagar).
5. Depois do pagamento, você volta para o site e vê a tela "Processando
   pagamento — Aguarde um instante...". É só agora, escondido dessa mensagem
   genérica, que a chamada real à OpenAI acontece. Confirme que, em alguns
   segundos, a foto final aparece automaticamente (o front-end fica
   consultando o pedido até ficar pronto).
6. Teste o botão de download.
7. (Opcional) Simule uma falha de geração pós-pagamento para ver a mensagem
   de erro amigável — nesse caso o pagamento já foi cobrado e precisa de
   acompanhamento manual (reembolso ou nova tentativa), já que ainda não há
   um fluxo automático para isso.

## Observações importantes

- **Armazenamento em memória:** os pedidos ficam guardados na memória do
  servidor (não em banco de dados). Se o serviço reiniciar no meio de um
  pedido (por exemplo, durante um redeploy), esse pedido específico se perde.
  O Railway não "dorme" como o plano gratuito do Render, então isso deve ser
  raro — mas ainda pode acontecer em um redeploy manual ou crash. Se o volume
  crescer, vale migrar para um banco de dados real.
- **Pagamento aprovado + geração com falha:** hoje isso só marca o pedido como
  `generation_failed` com uma mensagem pedindo para o cliente entrar em
  contato — não existe reembolso ou nova tentativa automática ainda. Vale
  acompanhar isso manualmente até criar um processo automatizado.
- **Nunca compartilhe o arquivo `.env`** nem cole essas chaves em nenhum lugar
  além das variáveis de ambiente do Railway.
