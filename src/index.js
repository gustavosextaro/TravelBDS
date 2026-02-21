// src/index.js

import { handleOrdersPaid, verifyShopifyHmac } from './webhookOrdersPaid.js';
import syncProducts from './syncProducts.js';
import { generate } from '@juit/qrcode'

// Handler para servir SVG de QR Code em /qr/<code>
async function handleQrRequest(request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/qr/')) return null;
  const code = decodeURIComponent(url.pathname.replace('/qr/', ''));
  // Gera PNG do QR Code
  const pngBytes = await generate(code, 'png', {
    scale: 10,
    margin: 1
  });
  return new Response(pngBytes, {
    headers: { 'Content-Type': 'image/png' }
  });
}

export default {
  async fetch(request, env, ctx) {
    // 1) ROTA /qr/:code → devolve PNG do QR Code
    const qrResp = await handleQrRequest(request);
    if (qrResp) {
      return qrResp;
    }

    const url = new URL(request.url);

    // 2) CORS Handlers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 3) Rota /api/products → retorna produtos do Shopify
    if (request.method === 'GET' && url.pathname === '/api/products') {
      try {
        const products = await syncProducts.getProductsForFrontend(env);
        return new Response(JSON.stringify(products), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
    }

    // 4) Webhook orders-paid: responde 200 rápido e processa em background
    if (request.method === 'POST' && url.pathname === '/webhooks/orders-paid') {
      // Lê corpo UMA VEZ para validar HMAC
      const bodyText = await request.text();
      const headerHmac = request.headers.get('X-Shopify-Hmac-Sha256');

      const isValid = await verifyShopifyHmac(
        env.SHOPIFY_WEBHOOK_SECRET,
        bodyText,
        headerHmac
      );

      if (!isValid) {
        return new Response('Unauthorized', { status: 401 });
      }

      // Dispara o processamento em background passando o bodyText já lido
      ctx.waitUntil(handleOrdersPaid(bodyText, env));

      // Responde OK imediatamente
      return new Response('Webhook processado com sucesso', { status: 200 });
    }

    // 3) Rota não encontrada
    return new Response('Rota não encontrada', { status: 404 });
  },

  /**
   * Handler agendado por cron
   */
  async scheduled(event, env, ctx) {
    await syncProducts.scheduled(event, env);
  }
};