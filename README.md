# eSIM Travel Buddies - Shopify Integration Middleware

Sistema de automação para venda e provisionamento de eSIMs através da Shopify, integrado com Maya API e executado em Cloudflare Workers.

## Visão Geral

Este middleware automatiza:
1. Sincronização de produtos eSIM da Maya para a Shopify
2. Processamento de webhooks de pedidos pagos
3. Provisionamento automático de eSIMs via Maya API
4. Envio de instruções de ativação por e-mail

## Arquitetura

### Módulos Principais

#### 1. `index.js` - Orquestrador
- **Rota `/qr/<code>`**: Gera e serve QR codes em PNG
- **Webhook `/webhooks/orders-paid`**: Processa pedidos pagos do Shopify
- **Cron job**: Executa sincronização agendada de produtos

#### 2. `syncProducts.js` - Sincronização de Produtos
- Busca produtos disponíveis na Maya API por região
- Filtra produtos baseado em regras de negócio
- Cria/atualiza produtos na Shopify via REST API
- **Congelamento de preços**: Preserva preços existentes, apenas cria novos com preços calculados

#### 3. `webhookOrdersPaid.js` - Processamento de Pedidos
- Valida HMAC do webhook Shopify
- Provisiona eSIM na Maya API
- Gera QR code de ativação
- Envia e-mail via MailChannels

## Configuração

### Variáveis de Ambiente

```bash
# Maya API
MAYA_API_KEY=sua_chave_maya
MAYA_API_SECRET=seu_secret_maya

# Shopify
SHOPIFY_STORE_DOMAIN=sua-loja.myshopify.com
SHOPIFY_ACCESS_TOKEN=seu_token_shopify
SHOPIFY_WEBHOOK_SECRET=seu_secret_webhook
SHOPIFY_LOCATION_ID=id_do_local_estoque

# MailChannels
MAILCHANNELS_API_KEY=sua_chave_mailchannels
MAILCHANNELS_SENDER_EMAIL=no-reply@seudominio.com

# Twilio (opcional - atualmente comentado)
TWILIO_SID=seu_sid
TWILIO_TOKEN=seu_token
TWILIO_WHATSAPP_FROM=+5521999999999
```

### Dependências

```json
{
  "dependencies": {
    "@juit/qrcode": "^1.x.x",
    "qrcode": "^1.x.x"
  }
}
```

### wrangler.toml

```toml
name = "esim-worker"
main = "src/index.js"
compatibility_date = "2025-01-01"

[triggers]
crons = ["0 */6 * * *"]  # Sincronização a cada 6 horas
```

## Regiões Configuradas

| Região | Handle | Código Maya | Países Cobertos |
|--------|--------|-------------|-----------------|
| Europa | `esim-europa` | `europe` | 35 países |
| Ásia | `esim-apac` | `apac` | 13 países |
| América Latina | `esim-latam` | `latam` | 17 países |
| Balcãs | `esim-balkans` | `balkans` | 9 países |
| Caribe | `esim-caribbean` | `caribbean` | 22 países |
| Oriente Médio | `esim-mena` | `mena` | 8 países |
| EUA | `esim-eua` | `us` | 1 país |
| Global | `esim-global` | `global` | 100+ países |
| Argentina | `esim-arg` | `ar` | 1 país |
| Chile | `esim-chl` | `cl` | 1 país |

## Sistema de Precificação

### Conversão de Moeda
- Taxa de câmbio fixa: **USD 1.00 = BRL 5.50**
- Arredondamento: `Math.ceil()` para cima

### Tipos de Planos

**Quota-Based**: Quantidade fixa de dados (5GB, 10GB, 20GB)  
**Ilimitados**: Disponíveis em algumas regiões
- `STANDARD`: Velocidade padrão
- `MAX`: Velocidade máxima

### Estrutura de SKU

```
Quota-based: {uid_maya}-{quota}GB-{dias}d
Exemplo: abc123-10GB-10d

Ilimitado: {uid_maya}-{tipo}-{dias}d
Exemplo: abc123-standard-10d
```

## Sincronização de Produtos

### Lógica de Congelamento de Preços

**Problema resolvido**: Evitar atualização automática de preços em produtos já existentes.

**Comportamento**:
1. SKU já existe → Mantém preço atual do Shopify
2. SKU novo → Usa preço calculado (necessário para criação)
3. Inclui `id` da variante no payload para garantir update, não duplicação

### Regras de Filtro

Para cada região, produtos são filtrados por:
1. **Cobertura**: Todos os `countryCodes` devem estar em `countries_enabled`
2. **Validade**: Deve estar em `allowedValidity`
3. **Quota**: Deve estar em `allowedQuotas`
4. **Tipo de plano**: Valida `planType` se configurado

### Processo de Sincronização

```
1. Para cada região configurada:
   ├─ Busca produtos na Maya API
   ├─ Filtra conforme regras de negócio
   ├─ Verifica produto existente via handle
   ├─ Mapeia SKUs existentes (preserva preço)
   ├─ Constrói payload com variantes
   ├─ POST (novo) ou PUT (atualização)
   └─ Log de resultado
```

## Fluxo de Processamento de Pedidos

### 1. Recebimento do Webhook

```
POST /webhooks/orders-paid
Headers:
  X-Shopify-Hmac-Sha256: {hmac}
Body: JSON do pedido Shopify
```

### 2. Validação HMAC

```javascript
// Usa crypto.subtle do Cloudflare Workers
// Algoritmo: HMAC-SHA256
const isValid = await verifyShopifyHmac(secret, bodyText, headerHmac);
```

### 3. Extração de Dados

```javascript
planHandle = sku.split('-')[0]  // Primeira parte do SKU
email = order.customer?.email
phone = order.customer?.phone
firstName = order.customer?.first_name
```

### 4. Provisionamento Maya

```javascript
POST https://api.maya.net/connectivity/v1/esim
Authorization: Basic {base64(key:secret)}
Body: { plan_type_id: "uid_do_plano" }

Response: {
  esim: {
    uid: "...",
    activation_code: "LPA:...",
    manual_code: "LPA:..."
  }
}
```

### 5. Geração de QR Code

- Utiliza `@juit/qrcode`
- Formato: PNG base64
- Endpoint: `https://worker-url/qr/{activation_code}`

### 6. Envio de E-mail

```javascript
POST https://api.mailchannels.net/tx/v1/send
Headers:
  X-Api-Key: {mailchannels_key}
Body: {
  personalizations: [{ to: [{ email }] }],
  from: { email, name },
  subject: "...",
  content: [{ type: "text/html", value: htmlBody }]
}
```

## Segurança

### Validação HMAC
- Utiliza Web Crypto API nativa do Workers
- Compara assinatura SHA-256 do body
- Rejeita requisições inválidas com 401

### Validação de Entrada
- **plan_type_id**: Regex `^[A-Za-z0-9\-_]{4,40}$`
- **Campos obrigatórios**: email, SKU válido
- **Try-catch**: Em todas as chamadas de API externa

### Limitações de Segurança
- Secrets devem estar em variáveis de ambiente
- Nunca comitar credenciais no código
- Rate limiting aplicado pelas APIs externas

## Deployment

### Pré-requisitos
- Cloudflare Workers account
- Shopify store com acesso Admin API
- Maya API credentials
- MailChannels API key

### Deploy

```bash
# 1. Instalar Wrangler CLI
npm install -g wrangler

# 2. Login Cloudflare
wrangler login

# 3. Configurar secrets
wrangler secret put MAYA_API_KEY
wrangler secret put MAYA_API_SECRET
wrangler secret put SHOPIFY_ACCESS_TOKEN
wrangler secret put SHOPIFY_WEBHOOK_SECRET
wrangler secret put MAILCHANNELS_API_KEY

# 4. Deploy
wrangler deploy
```

### Configuração Shopify Webhook

```
1. Admin → Settings → Notifications → Webhooks
2. Create webhook:
   - Event: Order payment
   - Format: JSON
   - URL: https://seu-worker.workers.dev/webhooks/orders-paid
   - API version: 2025-04
```

## Debugging e Monitoramento

### Logs em Tempo Real

```bash
wrangler tail
```

### Estrutura de Logs

```javascript
console.log('✅')  // Sucesso
console.log('➤')   // Checkpoint importante
console.log('🌐')  // Chamada de API
console.log('⚠️')  // Warning
console.error('❌') // Erro
console.error('💥') // Erro crítico
```

### Pontos de Atenção

1. **Timeout**: Workers têm limite de 30s por request
   - Webhook usa `ctx.waitUntil()` para processar em background
   
2. **Rate Limits**:
   - Maya API: Limitações por plano
   - Shopify REST API: 2 req/s (burst até 40)
   - MailChannels: Conforme plano

3. **Concurrent Updates**:
   - Sincronização usa last-write-wins
   - Não há lock distribuído

## Manutenção

### Adicionar Nova Região

Edite `syncProducts.js`:

```javascript
regionConfigs.push({
  key: "nova-regiao",
  mayaRegion: "codigo_maya",      // ou mayaCountry para país específico
  productHandle: "esim-nova-regiao",
  productTitle: "ESIM NOVA REGIÃO",
  countryCodes: ["BRA", "ARG"],
  allowedQuotas: [5000, 10000, 20000],
  allowedValidity: [6, 11, 16, 31],
  quotaPrices: {
    6:  ["19.99", "29.99", "39.99"],
    11: ["24.99", "34.99", "44.99"],
    16: ["29.99", "39.99", "49.99"],
    31: ["34.99", "44.99", "54.99"]
  },
  planType: "STANDARD",           // ou "MAX", ou null se não tiver ilimitado
  unlimitedPlanPrices: {
    11: ["49.99"],
    16: ["59.99"],
    31: ["69.99"]
  }
});
```

### Ajustar Taxa de Câmbio

Edite `syncProducts.js`:

```javascript
const exchangeRate = 5.5; // Altere aqui
```

**Importante**: Taxa afeta apenas SKUs novos devido ao congelamento de preços.

### Atualizar Preços Existentes

Preços congelados **não** são atualizados automaticamente. Para alterar:

1. Edite manualmente na Shopify Admin, ou
2. Delete o produto e deixe a sincronização recriar, ou
3. Modifique a lógica em `upsertSingleProductRest()` temporariamente

### Modificar Template de E-mail

Edite `htmlBody` em `webhookOrdersPaid.js`. Template atual inclui:
- Instruções de ativação iOS/Android
- QR code embutido
- Alertas importantes
- Informações de contato

## Troubleshooting

### Produto não sincroniza

**Verifique**:
- Logs do cron: `wrangler tail`
- Cobertura de países na Maya
- Validade e quotas permitidas
- planType configurado corretamente

### Webhook falha

**Verifique**:
- HMAC válido (401 = HMAC inválido)
- SKU do produto tem formato correto
- Logs da Maya API (pode rejeitar plan_type_id)
- MailChannels API key válida

### QR code não carrega

**Verifique**:
- Route `/qr/:code` está configurada
- activation_code foi extraído corretamente
- Worker está acessível publicamente

### E-mail não chega

**Verifique**:
- Domain Lockdown configurado no MailChannels
- MAILCHANNELS_SENDER_EMAIL autorizado
- API key válida
- Logs de resposta do MailChannels

## 📊 Limitações Conhecidas

1. **Estoque**: Código de ajuste de inventory está comentado
2. **WhatsApp**: Integração Twilio comentada
3. **Concorrência**: Sem lock para updates simultâneos
4. **Rollback**: Sem sistema de versionamento de preços
5. **Retry**: Sem retry automático em falhas de API

## Fluxo Completo (Resumo)

```
┌─────────────────────────────────────────────────────────────┐
│                    CRON JOB (a cada 6h)                     │
├─────────────────────────────────────────────────────────────┤
│ 1. Para cada região (10 regiões)                            │
│ 2. Busca produtos na Maya API                               │
│ 3. Filtra por cobertura + validade + quota + planType       │
│ 4. Verifica produto existente no Shopify                    │
│ 5. Constrói variantes (preserva preços existentes)          │
│ 6. POST ou PUT no Shopify REST API                          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│              WEBHOOK: Cliente paga pedido                   │
├─────────────────────────────────────────────────────────────┤
│ 1. Shopify POST /webhooks/orders-paid                       │
│ 2. Worker valida HMAC                                        │
│ 3. Extrai plan_type_id do SKU                               │
│ 4. POST na Maya API → Provisiona eSIM                       │
│ 5. Gera QR code PNG                                          │
│ 6. Envia e-mail via MailChannels                            │
│ 7. Retorna 200 OK para Shopify                              │
└─────────────────────────────────────────────────────────────┘
```

---

**Versão**: 1.0.0  
**Última atualização**: Julho 2025