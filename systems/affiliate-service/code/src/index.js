const express = require('express');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4004;
const partners = [
  {
    id: 'aff-001',
    name: 'Launch Partner',
    code: 'LAUNCH10',
    commission_rate: 0.1,
    status: 'active'
  }
];
const referrals = [];
const commissions = [];

app.post('/affiliate/referral', (req, res) => {
  const { affiliate_id, referral_code, source, landing_url } = req.body;
  if (!affiliate_id || !referral_code) {
    return res.status(400).json({ error: 'affiliate_id and referral_code are required' });
  }

  const referral = {
    id: `ref-${Date.now()}`,
    affiliate_id,
    referral_code,
    source: source || 'unknown',
    landing_url: landing_url || null,
    created_at: new Date().toISOString()
  };
  referrals.push(referral);
  res.status(201).json(referral);
});

app.get('/affiliate/partners/:partnerId', (req, res) => {
  const partner = partners.find((p) => p.id === req.params.partnerId);
  if (!partner) {
    return res.status(404).json({ error: 'Affiliate partner not found' });
  }
  res.json(partner);
});

app.get('/affiliate/referrals/:code', (req, res) => {
  const referral = referrals.find((r) => r.referral_code === req.params.code);
  if (!referral) {
    return res.status(404).json({ error: 'Referral code not found' });
  }
  res.json(referral);
});

app.post('/affiliate/commissions/:orderId', (req, res) => {
  const { affiliate_id, referral_code, commission_rate, commission_amount } = req.body;
  if (!affiliate_id && !referral_code) {
    return res.status(400).json({ error: 'affiliate_id or referral_code is required' });
  }

  const commission = {
    id: `comm-${Date.now()}`,
    order_id: req.params.orderId,
    affiliate_id: affiliate_id || null,
    referral_code: referral_code || null,
    commission_rate: commission_rate || 0,
    commission_amount: commission_amount || 0,
    status: 'pending'
  };
  commissions.push(commission);
  res.status(201).json(commission);
});

app.listen(PORT, () => {
  console.log(`affiliate-service listening on port ${PORT}`);
});
