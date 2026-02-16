import { fetchRecommend } from '../src/client.js';

async function main() {
  const res = await fetchRecommend({ need: 'smart contract security' });
  const top = res.recommendations?.[0];
  console.log('Top result:', JSON.stringify(top, null, 2));
  console.log('\nHas endpoints?', !!top?.endpoints);
  console.log('Has bazaar_resource_url?', !!top?.bazaar_resource_url);
  console.log('Source:', top?.source);
}
main().catch(console.error);
