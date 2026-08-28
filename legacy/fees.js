/* Steam market fee helpers. Amounts are integer cents of the wallet currency. */

const SRP_FEE = {
  steamPercent: 0.05,
  steamMinimum: 1,
  steamBase: 0,
};

function srpApplyWallet(wallet) {
  if (!wallet) return;
  if (wallet.wallet_fee_percent != null) {
    SRP_FEE.steamPercent = parseFloat(wallet.wallet_fee_percent) || 0.05;
  }
  if (wallet.wallet_fee_minimum != null) {
    SRP_FEE.steamMinimum = parseInt(wallet.wallet_fee_minimum, 10) || 1;
  }
  if (wallet.wallet_fee_base != null) {
    SRP_FEE.steamBase = parseInt(wallet.wallet_fee_base, 10) || 0;
  }
}

function srpBuyerPrice(sellerCents, publisherFeePercent) {
  sellerCents = parseInt(sellerCents, 10) || 0;
  var pub = publisherFeePercent == null ? 0.1 : parseFloat(publisherFeePercent);
  if (sellerCents <= 0) return 0;
  var steamFee =
    Math.floor(Math.max(sellerCents * SRP_FEE.steamPercent, SRP_FEE.steamMinimum) + SRP_FEE.steamBase);
  var pubFee = pub > 0 ? Math.floor(Math.max(sellerCents * pub, 1)) : 0;
  return sellerCents + steamFee + pubFee;
}

/** Largest seller-receive cents whose buyer price is <= targetBuyer. */
function srpSellerForBuyer(targetBuyer, publisherFeePercent) {
  targetBuyer = parseInt(targetBuyer, 10) || 0;
  if (targetBuyer <= 0) return 0;
  var lo = 1;
  var hi = targetBuyer;
  var best = 0;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    var buyer = srpBuyerPrice(mid, publisherFeePercent);
    if (buyer <= targetBuyer) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function srpFormatCents(cents, currencyId) {
  var n = (Number(cents) || 0) / 100;
  var body = n.toFixed(2).replace(".", ",");
  if (currencyId === 5) return body + "\u20bd";
  if (currencyId === 1) return "$" + n.toFixed(2);
  if (currencyId === 3) return body + "\u20ac";
  return body;
}
