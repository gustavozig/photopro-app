require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');

const orderStore = require('./services/orderStore');
const mercadoPagoService = require('./services/mercadoPagoService');
const ordersRouter = require('./routes/orders');
const webhooksRouter = require('./routes/webhooks');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

app.set('publicUrl', PUBLIC_URL);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Config pública para o front-end montar o checkout embutido (Payment
// Brick). MP_PUBLIC_KEY é, por definição, segura para expor no cliente —
// é diferente do MP_ACCESS_TOKEN (esse sim secreto, nunca sai do servidor).
// Se MP_PUBLIC_KEY não estiver configurada ainda, o front-end cai
// automaticamente no fluxo antigo (Checkout Pro com redirect).
// ---------------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({
    mpPublicKey: process.env.MP_PUBLIC_KEY || null,
    priceBRL: mercadoPagoService.PRICE_BRL,
  });
});

app.use('/api', ordersRouter);
app.use('/api', webhooksRouter);

// limpeza periódica de pedidos antigos (evita vazamento de memória)
setInterval(orderStore.purgeExpiredOrders, 15 * 60 * 1000);

// fallback: qualquer outra rota devolve o front-end
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PhotoPRO rodando na porta ${PORT}`);
  console.log(`PUBLIC_URL configurada como: ${PUBLIC_URL}`);
  console.log('Regra ativa: nenhuma chamada à OpenAI antes do pagamento aprovado.');
});
