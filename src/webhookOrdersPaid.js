/*
 * webhookOrdersPaid.js
 *
 * Handler para o webhook "orders/paid" do Shopify:
 * 1) Valida HMAC do Shopify
 * 2) Extrai dados do pedido (UID Maya via SKU, e-mail, telefone)
 * 3) Chama API Maya Connect+ para gerar o eSIM e data plan
 * 4) Gera QR code (PNG Base64)
 * 5) Envia instruções por e-mail (MailChannels) e WhatsApp (Twilio)
 */

// ———————————————————————————————————————————————————————————————————————————————
// IMPORTS & DEPENDÊNCIAS
// ———————————————————————————————————————————————————————————————————————————————
// No Workers, fetch e crypto.subtle já estão disponíveis globalmente
import { generate } from '@juit/qrcode';

// ———————————————————————————————————————————————————————————————————————————————
// Função: verifyShopifyHmac
// ———————————————————————————————————————————————————————————————————————————————
/**
 * Verifica se o HMAC recebido bate com o HMAC calculado no corpo da requisição.
 * @param {string} secret      Segredo do webhook configurado no Shopify
 * @param {string} bodyText    Corpo cru da requisição (string)
 * @param {string} headerHmac  Valor do header X-Shopify-Hmac-Sha256
 * @returns {Promise<boolean>} true se o HMAC for válido, false caso contrário
 */
export async function verifyShopifyHmac(secret, bodyText, headerHmac) {
  // 1) Cria um TextEncoder para converter strings em Uint8Array
  const encoder = new TextEncoder();

  // 2) Importa a chave secreta para o algoritmo HMAC-SHA256
  const key = await crypto.subtle.importKey(
    'raw',                                 // formato da chave
    encoder.encode(secret),               // bytes do segredo
    { name: 'HMAC', hash: 'SHA-256' },     // algoritmo e função hash
    false,                                 // não exportável
    ['verify']                             // uso: verify (não precisamos de sign)
  );

  // 3) Converte o header HMAC (base64) em um buffer de bytes
  const signature = Uint8Array.from(
    atob(headerHmac),                      // decodifica base64 → string
    c => c.charCodeAt(0)                   // mapeia cada caractere para seu código UTF-16
  );

  // 4) Verifica internamente se o HMAC calculado bate com a assinatura
  const valid = await crypto.subtle.verify(
    'HMAC',                                // HMAC
    key,                                   // chave importada
    signature,                             // assinatura recebida
    encoder.encode(bodyText)               // os dados a assinar (corpo da requisição)
  );

  return valid;
}

// ———————————————————————————————————————————————————————————————————————————————
// Função: provisionMayaEsim
// ———————————————————————————————————————————————————————————————————————————————
/**
 * Envia requisição à API Maya para criar um eSIM + data plan de uma vez.
 * @param {string} planTypeId  UID do plano Maya (primeira parte do SKU)
 * @param {object} env         Variáveis de ambiente (MAYA_API_KEY, MAYA_API_SECRET)
 * @returns {Promise<object>}   JSON de resposta da Maya
 * @throws {Error}             Se falhar validação ou a própria requisição Maya retornar erro
 */
async function provisionMayaEsim(planTypeId, env) {
  // 1) Validação simples do formato do UID (letras, números, '-', '_')
  if (!/^[A-Za-z0-9\-_]{4,40}$/.test(planTypeId)) {
    console.error('💥 planTypeId inválido antes de chamar Maya:', planTypeId);
    throw new Error(`planTypeId inválido: "${planTypeId}"`);
  }

  // 2) Monta credenciais Basic Auth para Maya (base64 de key:secret)
  const creds = btoa(`${env.MAYA_API_KEY}:${env.MAYA_API_SECRET}`);
  const url   = 'https://api.maya.net/connectivity/v1/esim';
  const body  = { plan_type_id: planTypeId };

  // 3) Logs de debugging
  console.log('🌐 Maya API – URL:', url);
  console.log('🌐 Maya API – Payload:', JSON.stringify(body));

  // 4) Executa a requisição POST
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,  // Basic Auth
      'Content-Type':  'application/json'
    },
    body: JSON.stringify(body)
  });

  // 5) Tenta converter a resposta em JSON para logs
  let json;
  try {
    json = await res.json();
  } catch (e) {
    console.error('❌ Maya retornou sem JSON:', await res.text());
    throw new Error(`Maya API retornou status ${res.status} sem JSON`);
  }

  // 6) Log da resposta
  console.log('🌐 Maya API – Status:', res.status);
  console.log('🌐 Maya API – Body:', json);

  // 7) Lança erro se status não for 2xx
  if (!res.ok) {
    const errorMsg = json.message || JSON.stringify(json);
    throw new Error(`Maya API retornou status ${res.status}: ${errorMsg}`);
  }

  return json;
}

/**
 * Gera um Data URL contendo um QR code em PNG (base64) para o texto fornecido.
 * @param {string} qrString   activation_code ou manual_code da Maya
 * @returns {Promise<string>} Data URL PNG base64 (ex: "data:image/png;base64,...")
 * @throws {Error}           Se falhar a geração do QR code
 */
export async function generateQrDataUrl(qrString) {
  try {
    // Gera o QR code em formato PNG
    const pngBuffer = await generate(qrString, 'png', {
      scale: 10,
      margin: 1
    });
    // Converte o buffer para base64
    const base64 = btoa(String.fromCharCode(...pngBuffer));
    return `data:image/png;base64,${base64}`;
  } catch (err) {
    console.error('❌ Erro ao gerar QR Code:', err);
    throw new Error('Erro ao gerar QR Code');
  }
}

// ———————————————————————————————————————————————————————————————————————————————
// EXPORTS
// ———————————————————————————————————————————————————————————————————————————————
export { provisionMayaEsim };

// ———————————————————————————————————————————————————————————————————————————————
// Handler Principal: handleOrdersPaid
// ———————————————————————————————————————————————————————————————————————————————
/**
 * Main entrypoint para o webhook orders/paid do Shopify.
 * @param {string} bodyText  Body da requisição já lido como texto
 * @param {object} env       Variáveis de ambiente do Worker
 * @returns {Promise<void>}  Não retorna Response (roda em background)
 */
export async function handleOrdersPaid(bodyText, env) {
  console.log('>>> Entrada em handleOrdersPaid');
  try {
    // —————————————————————————————————————————
    // 1) Parse do JSON & logs
    // —————————————————————————————————————————
    const order = JSON.parse(bodyText);
    console.log('Pedido pago recebido:', order.id);
    order.line_items.forEach(item =>
      console.log('Line item properties:', item.properties)
    );

    // —————————————————————————————————————————
    // 2) Extrai planHandle (UID Maya) do SKU
    // —————————————————————————————————————————
    let planHandle;
    let fallbackSku;
    for (const itm of order.line_items) {
      fallbackSku = itm.sku;
      planHandle  = itm.sku?.split('-')[0];  // pega a primeira parte antes do "-"
      break;                                  // só precisamos do primeiro item
    }
    if (!planHandle) {
      console.error('❌ plan_type_id não encontrado no SKU:', fallbackSku);
      return;
    }
    console.log('✔️ plan_type_id extraído do SKU:', planHandle);

    // —————————————————————————————————————————
    // 3) Extrai dados de contato
    // —————————————————————————————————————————
    const email     = order.customer?.email;
    const phone     = order.customer?.phone;
    const firstName = order.customer?.first_name || 'Cliente';

    if (!email) {
      console.error('❌ E-mail ausente no pedido:', order.id);
      return;
    }

    // —————————————————————————————————————————
    // 4) Chama Maya e gera QR
    // —————————————————————————————————————————
    let mayaResp, activation_code, activationDate;
    try {
      mayaResp       = await provisionMayaEsim(planHandle, env);
      activation_code = mayaResp.esim.activation_code || mayaResp.esim.manual_code;
      // Data atual formatada DD/MM/YYYY
      const now = new Date();
      activationDate = 
        now.getDate().toString().padStart(2,'0') + '/' +
        (now.getMonth()+1).toString().padStart(2,'0') + '/' +
        now.getFullYear();
      console.log('✅ eSIM provisionado com sucesso');
    } catch (err) {
      console.error('❌ Erro no provisionamento:', err);
      return;
    }

    // 5) Monta URL do QR Code (servido pelo próprio Worker)
    // Nota: Não podemos usar request.url aqui pois estamos em background
    // Usar env.WORKER_URL ou construir baseado no domínio conhecido
    const workerUrl = env.WORKER_URL || 'https://seu-worker.workers.dev';
    const qrUrl = `${workerUrl}/qr/${activation_code}`;
    const esimId = mayaResp.esim.uid;

    // —————————————————————————————————————————
    // 6) Monta HTML do e-mail
    // —————————————————————————————————————————
    const htmlBody = `
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Como ativar seu eSIM – Travel Buddies</title>
      <style>
        @media screen and (max-width: 480px) {
          .mobile-padding {
            padding: 15px !important;
          }
          .mobile-font {
            font-size: 18px !important;
          }
          .mobile-small-font {
            font-size: 14px !important;
          }
          .mobile-container {
            width: 100% !important;
          }
        }
      </style>
    </head>
    <body style="margin:0;padding:0;font-family:Arial,sans-serif;background-color:#f5f5f5;color:#333;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
        <tr>
          <td align="center" style="padding:0;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;background-color:#ffffff;" class="mobile-container">
              <!-- Header com altura reduzida -->
              <tr>
                <td style="background-color:#ffffff;padding:15px 0;text-align:center;">
                  <img
                    src="https://cdn.shopify.com/s/files/1/0673/6966/4565/files/TravelBDS_Logo_4.png?v=1746931195"
                    alt="Travel Buddies Logo"
                    style="display:block;margin:0 auto;max-width:180px;width:80%;height:auto;"
                  >
                </td>
              </tr>

              <!-- Main content -->
              <tr>
                <td class="mobile-padding" style="padding:30px 40px;">
                  <h1 class="mobile-font" style="color:#1EAEDB;font-size:24px;margin-top:0;margin-bottom:20px;">
                    Olá, ${firstName}!
                  </h1>
                  <p style="margin-top:0;margin-bottom:20px;line-height:1.5;">A equipe <span style="color:#ea384c;font-weight:bold;">Travel Buddies</span> agradece pela confiança! Vamos te ajudar a instalar o seu eSIM em poucos passos.</p>

                  <!-- Important alert -->
                  <div style="background:#f8f9fa;border-left:4px solid #ea384c;padding:15px;margin-bottom:25px;border-radius:4px;">
                    <p style="margin-top:0;margin-bottom:10px;font-weight:bold;color:#000000;font-size:16px;">⚠️ IMPORTANTE – Leia antes de ativar:</p>
                    <ul style="margin:0;padding-left:20px;color:#333333;">
                      <li style="margin-bottom:8px;"><strong>Verifique se o seu celular é compatível com eSIM.</strong></li>
                      <li style="margin-bottom:8px;">Esteja conectado à internet.</li>
                      <li style="margin-bottom:8px;">Não escolha "Transferir seu número" – use o eSIM Travel Buddies.</li>
                      <li style="margin-bottom:8px;">Seu plano irá iniciar somente quando o QR code for ativado.</li>
                    </ul>
                  </div>

                  <!-- Installation instructions -->
                  <h2 class="mobile-font" style="color:#1EAEDB;font-size:20px;margin-top:0;margin-bottom:15px;border-bottom:2px solid #f1f1f1;padding-bottom:10px;">
                    Como instalar
                  </h2>
                  <ol style="margin-top:0;margin-bottom:25px;padding-left:20px;line-height:1.6;">
                    <li style="margin-bottom:12px;">Abra a câmera do celular e escaneie o QR abaixo:</li>
                      <img
                        src="${qrUrl}"
                        alt="QR Code para ativação"
                        style="display:block;margin:15px auto;max-width:220px;width:100%;height:auto;border:1px solid #f1f1f1;border-radius:8px;padding:10px;"
                      >
                    </li>
                    <!-- Nova mensagem adicionada sobre como ativar quando não consegue escanear -->
                    <li style="margin-bottom:12px;">
                      Caso esteja no celular de ativação e não consiga escanear o QR code, siga estes passos:
                      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;">
                        <tr>
                          <td style="padding:12px;background-color:#f8f9fa;border-radius:4px;">
                            <p style="margin:0 0 8px 0;font-weight:bold;color:#1EAEDB;">iPhone:</p>
                            <p style="margin:0;color:#333333;">Clique e segure no código QR. Nas opções, clique em <strong>"Adicionar eSIM".</strong></p>
                          </td>
                        </tr>
                        <tr>
                          <td style="height:10px;"></td>
                        </tr>
                        <tr>
                          <td style="padding:12px;background-color:#f8f9fa;border-radius:4px;">
                            <p style="margin:0 0 8px 0;font-weight:bold;color:#ea384c;">Android:</p>
                            <p style="margin:0;color:#333333;">Tire um print do email com o QR code. Abra o print, clique e segure no QR code e escolha a opção <strong>"Adicionar Plano ao Telefone"</strong></p>
                          </td>
                        </tr>
                      </table>
                    </li>
                    <li style="margin-bottom:12px;">Siga as instruções na tela para adicionar o plano.</li>
                    <h2 class="mobile-font" style="color:#1EAEDB;font-size:20px;margin-top:0;margin-bottom:15px;border-bottom:2px solid #f1f1f1;padding-bottom:10px;">
                    Após a instalação
                    </h2>
                      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;">
                        <tr>
                          <td style="padding:12px;background-color:#f8f9fa;border-radius:4px;">
                            <p style="margin:0 0 8px 0;font-weight:bold;color:#1EAEDB;">iPhone:</p>
                            <p style="margin:0;color:#333333;">Ajustes &gt; Celular &gt; defina TravelBDS como principal e ative Roaming de Dados.</p>
                          </td>
                        </tr>
                        <tr>
                          <td style="height:10px;"></td>
                        </tr>
                        <tr>
                          <td style="padding:12px;background-color:#f8f9fa;border-radius:4px;">
                            <p style="margin:0 0 8px 0;font-weight:bold;color:#ea384c;">Android:</p>
                            <p style="margin:0;color:#333333;">Configurações &gt; Conexões &gt; Gerenciador de Chip &gt; selecione o eSIM travelBDS e ative o Roaming de Dados.</p>
                          </td>
                        </tr>
                      </table>
                    </li>
                  </ol>

                  <!-- Contact and tips -->
                  <div style="background:#f8f9fa;border-radius:4px;padding:15px;margin-bottom:25px;">
                    <p style="margin-top:0;margin-bottom:15px;line-height:1.5;">O ID do seu ESIM é <strong>${esimId}</strong>. Guarde o ID, pois ele é importante para identificarmos seu ESIM em caso de problemas!</p>
                    <p style="margin-top:0;margin-bottom:0;line-height:1.5;"><span style="color:#1EAEDB;font-weight:bold;">💡 Dica:</span> Desative a sincronização do iCloud, Google Fotos ou qualquer aplicativo que use dados em segundo plano para conservar seus dados.</p>
                    <p style="margin-top:0;margin-bottom:15px;line-height:1.5;">Se tiver qualquer problema ao ativar seu plano de dados, entre em contato conosco!</p>
                  </div>

                  <!-- Closing -->
                  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;">
                    <tr>
                      <td>
                        <p style="margin:0 0 5px 0;line-height:1.5;">Boa viagem! ✈️</p>
                        <p style="margin:0 0 5px 0;line-height:1.5;">Com gratidão,</p>
                        <p style="margin:0;line-height:1.5;font-weight:bold;color:#ea384c;">Equipe Travel Buddies</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Footer com altura reduzida -->
              <tr>
                <td>
                  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#000000;">
                    <tr>
                      <td align="center" class="mobile-padding" style="padding:15px;">
                        <img
                          src="https://cdn.shopify.com/s/files/1/0673/6966/4565/files/TravelBDS_Logo_4.png?v=1746931195"
                          alt="Travel Buddies Logo"
                          style="display:block;margin:0 auto 10px;max-width:130px;width:70%;height:auto;"
                        >
                        <p class="mobile-small-font" style="margin:5px 0 0;font-size:14px;line-height:1.6;color:#ffffff;">
                          📞 +55 (21) 99652-8436 | 
                          <a href="mailto:contato@travelbds.com" style="color:#1EAEDB;text-decoration:none;font-weight:bold;">
                            contato@travelbds.com
                          </a> | 
                          <a href="https://travelbds.com" style="color:#ea384c;text-decoration:none;font-weight:bold;">
                            travelbds.com
                          </a>
                        </p>
                        <div style="margin-top:10px;">
                          <a href="https://www.facebook.com/profile.php?id=61575944374538" style="display:inline-block;margin:0 8px;"><img src="https://img.icons8.com/ios-filled/30/1EAEDB/facebook-new.png" alt="Facebook" style="width:24px;height:24px;"></a>
                          <a href="https://www.instagram.com/esimtravelbds?igsh=MTNsaDV3NGg5c3V4bQ==" style="display:inline-block;margin:0 8px;"><img src="https://img.icons8.com/ios-filled/30/ea384c/instagram-new.png" alt="Instagram" style="width:24px;height:24px;"></a>
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
    `;

    // —————————————————————————————————————————
    // 7) Envia e-mail via MailChannels Send API
    // —————————————————————————————————————————
    console.log('Enviando e-mail para:', email);
    const mailRes = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': env.MAILCHANNELS_API_KEY
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [{ email: email }]
          }
        ],
        from: {
          email: env.MAILCHANNELS_SENDER_EMAIL,
          name:  'Travel Buddies'
        },
        subject: 'Seu eSIM Travel Buddies',
        content: [
          {
            type:  'text/html',
            value: htmlBody
          }
        ]
      })
    });

    if (!mailRes.ok) {
      console.error(
        '❌ MailChannels falhou:',
        mailRes.status,
        await mailRes.text()
      );
    } else {
      console.log(`✉️ E-mail enviado com sucesso para ${email}`);
    }

    // —————————————————————————————————————————
    // 8) Envia WhatsApp via Twilio (se telefone válido)
    // —————————————————————————————————————————
    /* if (phone && phone.startsWith('+')) {
      const twilioRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${btoa(env.TWILIO_SID + ':' + env.TWILIO_TOKEN)}`,
            'Content-Type':  'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({
            From: `whatsapp:${env.TWILIO_WHATSAPP_FROM}`,
            To:   `whatsapp:${phone}`,
            Body: `Olá ${firstName}, seu eSIM está pronto! Confira seu e-mail para o QR code.`
          })
        }
      );
      if (!twilioRes.ok) {
        console.error('❌ Twilio WhatsApp falhou:', twilioRes.status, await twilioRes.text());
      } else {
        console.log('📱 WhatsApp enviado');
      }
    } else {
      console.warn('⚠️ Telefone inválido ou ausente, pulando WhatsApp');
    } */

  } catch (err) {
    console.error('❌ ERRO GERAL em handleOrdersPaid:', err);
  }
}