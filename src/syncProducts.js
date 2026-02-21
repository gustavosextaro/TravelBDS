
// syncProducts.js - Restored for frontend API support
async function getProductsForFrontend(env) {
    const shopDomain = env.SHOPIFY_STORE_DOMAIN;
    const shopToken = env.SHOPIFY_ACCESS_TOKEN;

    const url = `https://${shopDomain}/admin/api/2025-04/products.json?limit=50`;
    const res = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': shopToken }
    });

    if (!res.ok) {
        throw new Error(`Erro ao buscar produtos do Shopify: ${res.statusText}`);
    }

    const json = await res.json();
    return json.products.map(p => ({
        id: p.id,
        title: p.title,
        handle: p.handle,
        body_html: p.body_html,
        vendor: p.vendor,
        product_type: p.product_type,
        image: p.image,
        variants: p.variants.map(v => ({
            id: v.id,
            price: v.price,
            option1: v.option1.replace(/Unlimited/i, 'Ilimitado'),
            option2: v.option2.replace(/Unlimited/i, 'Ilimitado'),
            sku: v.sku
        }))
    }));
}

export default {
    getProductsForFrontend
};
