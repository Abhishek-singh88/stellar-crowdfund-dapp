'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useState } from 'react';
import * as StellarSdk from '@stellar/stellar-sdk';
import * as WalletsKit from '@creit.tech/stellar-wallets-kit';

type TxStatus = 'idle' | 'pending' | 'success' | 'failed';

type CampaignState = {
  goalStroops: bigint;
  raisedStroops: bigint;
  donors: number;
};

const RPC_URL = process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';
const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? '';
const CAMPAIGN_GOAL_XLM = Number(process.env.NEXT_PUBLIC_CAMPAIGN_GOAL_XLM ?? '100');
const READONLY_ACCOUNT = process.env.NEXT_PUBLIC_READONLY_ACCOUNT ?? '';
const OWNER_ADDRESS = process.env.NEXT_PUBLIC_OWNER_ADDRESS ?? '';

const STROOPS_PER_XLM = 10_000_000n;

const toStroops = (value: string): bigint => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0n;
  return BigInt(Math.floor(parsed * Number(STROOPS_PER_XLM)));
};

const stroopsToXlm = (stroops: bigint): string => (Number(stroops) / Number(STROOPS_PER_XLM)).toFixed(2);

const shorten = (text: string): string => (text.length < 12 ? text : `${text.slice(0, 6)}...${text.slice(-4)}`);

export default function Home() {
  const [kit, setKit] = useState<any>(null);
  const [publicKey, setPublicKey] = useState('');
  const [nativeBalance, setNativeBalance] = useState('0');
  const [amount, setAmount] = useState('');
  const [campaign, setCampaign] = useState<CampaignState>({
    goalStroops: BigInt(Math.floor(CAMPAIGN_GOAL_XLM * Number(STROOPS_PER_XLM))),
    raisedStroops: 0n,
    donors: 0,
  });
  const [txStatus, setTxStatus] = useState<TxStatus>('idle');
  const [txHash, setTxHash] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastEventId, setLastEventId] = useState('');

  const horizonServer = useMemo(() => new (StellarSdk as any).Horizon.Server(HORIZON_URL), []);
  const rpcServer = useMemo(() => new (StellarSdk as any).rpc.Server(RPC_URL), []);

  useEffect(() => {
    try {
      const network = (WalletsKit as any).WalletNetwork?.TESTNET ?? 'TESTNET';
      const modules = (WalletsKit as any).allowAllModules ? (WalletsKit as any).allowAllModules() : [];
      const walletKit = new (WalletsKit as any).StellarWalletsKit({
        network,
        modules,
        appName: 'Stellar Crowdfund dApp',
      });
      setKit(walletKit);
    } catch {
      setMessage(
        'Wallet SDK failed to initialize. Install dependencies and ensure Freighter/Albedo are available.',
      );
    }
  }, []);

  const loadWalletBalance = useCallback(async () => {
    if (!publicKey) return;
    try {
      const account = await horizonServer.loadAccount(publicKey);
      const xlm = account.balances.find((b: any) => b.asset_type === 'native')?.balance ?? '0';
      setNativeBalance(xlm);
    } catch {
      setNativeBalance('0');
    }
  }, [horizonServer, publicKey]);

  const readCampaign = useCallback(async () => {
    if (!CONTRACT_ID) return;
    const readAccountKey = publicKey || READONLY_ACCOUNT;
    if (!readAccountKey) return;
    try {
      const account = await horizonServer.loadAccount(readAccountKey);
      const contract = new (StellarSdk as any).Contract(CONTRACT_ID);
      const tx = new (StellarSdk as any).TransactionBuilder(account, {
        fee: (StellarSdk as any).BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('get_campaign'))
        .setTimeout(30)
        .build();

      const simulation = await rpcServer.simulateTransaction(tx);
      const scVal = simulation?.result?.retval;
      const decoded = scVal ? (StellarSdk as any).scValToNative(scVal) : null;

      if (decoded) {
        const goal = BigInt(decoded.goal ?? campaign.goalStroops);
        const raised = BigInt(decoded.total_raised ?? 0);
        const donors = Number(decoded.donors ?? 0);
        setCampaign({
          goalStroops: goal,
          raisedStroops: raised,
          donors,
        });
      }
    } catch {
      // keep polling resilient while wallet/RPC reconnects
    }
  }, [campaign.goalStroops, horizonServer, publicKey, rpcServer]);

  const pollEvents = useCallback(async () => {
    if (!CONTRACT_ID) return;
    try {
      const events = await rpcServer.getEvents({
        filters: [{ contractIds: [CONTRACT_ID], type: 'contract' }],
        limit: 20,
      });

      if (!events?.events?.length) return;
      const latest = events.events[events.events.length - 1];
      if (!latest?.id || latest.id === lastEventId) return;
      setLastEventId(latest.id);
      await readCampaign();
    } catch {
      // fallback refresh still handled by periodic readCampaign
    }
  }, [lastEventId, readCampaign, rpcServer]);

  const connectWallet = async () => {
    if (!kit) {
      setMessage('Wallet kit is not ready yet.');
      return;
    }
    try {
      setMessage('');
      await kit.openModal({
        modalTitle: 'Select Wallet',
        onWalletSelected: async (option: any) => {
          kit.setWallet(option.id);
          const { address } = await kit.getAddress();
          if (!address) {
            throw new Error('wallet_not_found');
          }
          setPublicKey(address);
        },
        onClosed: () => {
          if (!publicKey) {
            setMessage('Wallet connection was rejected or cancelled.');
          }
        },
      });
    } catch (error: any) {
      if (error?.message?.includes('wallet_not_found') || error?.message?.includes('not found')) {
        setMessage('Wallet not found. Install Freighter/Albedo or connect using WalletConnect.');
        return;
      }
      setMessage('Wallet connection was rejected or cancelled.');
    }
  };

  const donate = async () => {
    if (!CONTRACT_ID) {
      setMessage('Set NEXT_PUBLIC_CONTRACT_ID before donating.');
      return;
    }
    if (!OWNER_ADDRESS) {
      setMessage('Set NEXT_PUBLIC_OWNER_ADDRESS before donating.');
      return;
    }

    const amountStroops = toStroops(amount);
    if (!publicKey || amountStroops <= 0n) {
      setMessage('Enter a valid donation amount and connect a wallet.');
      return;
    }

    if (Number(nativeBalance) < Number(amount)) {
      setMessage('Insufficient balance for this donation amount.');
      setTxStatus('failed');
      return;
    }

    try {
      setIsSubmitting(true);
      setTxStatus('pending');
      setMessage('Sending payment to campaign owner...');

      if (!kit) {
        throw new Error('wallet_not_found');
      }

      const paymentAccount = await horizonServer.loadAccount(publicKey);
      const paymentTx = new (StellarSdk as any).TransactionBuilder(paymentAccount, {
        fee: (StellarSdk as any).BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          (StellarSdk as any).Operation.payment({
            destination: OWNER_ADDRESS,
            asset: (StellarSdk as any).Asset.native(),
            amount,
          })
        )
        .setTimeout(30)
        .build();

      const signedPayment = await kit.signTransaction(paymentTx.toXDR(), {
        address: publicKey,
        networkPassphrase: NETWORK_PASSPHRASE,
      });
      const signedPaymentXdr = signedPayment?.signedTxXdr ?? signedPayment;
      const signedPaymentTx = (StellarSdk as any).TransactionBuilder.fromXDR(
        signedPaymentXdr,
        NETWORK_PASSPHRASE
      );
      const paymentResult = await horizonServer.submitTransaction(signedPaymentTx);
      if (!paymentResult?.hash) {
        throw new Error('Payment failed to submit.');
      }

      setMessage('Payment sent. Recording donation on-chain...');

      const sourceAccount = await horizonServer.loadAccount(publicKey);
      const contract = new (StellarSdk as any).Contract(CONTRACT_ID);
      const donorScVal = new (StellarSdk as any).Address(publicKey).toScVal();
      const amountScVal = (StellarSdk as any).nativeToScVal(amountStroops, { type: 'i128' });

      const tx = new (StellarSdk as any).TransactionBuilder(sourceAccount, {
        fee: (StellarSdk as any).BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call('donate', donorScVal, amountScVal))
        .setTimeout(30)
        .build();

      const simulated = await rpcServer.simulateTransaction(tx);
      if (simulated?.error) {
        throw new Error(`Simulation failed: ${simulated.error}`);
      }

      const prepared = (StellarSdk as any).rpc.assembleTransaction(tx, simulated).build();
      const signed = await kit.signTransaction(prepared.toXDR(), {
        address: publicKey,
        networkPassphrase: NETWORK_PASSPHRASE,
      });
      const signedXdr = signed?.signedTxXdr ?? signed;

      const signedTx = (StellarSdk as any).TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
      const sendResult = await rpcServer.sendTransaction(signedTx);
      const hash = sendResult?.hash ?? '';
      if (hash) {
        setTxHash(hash);
      }
      if (sendResult?.status && sendResult.status !== 'PENDING') {
        const detail = sendResult?.errorResultXdr ? ` Error XDR: ${sendResult.errorResultXdr}` : '';
        throw new Error(`Transaction rejected: ${sendResult.status}.${detail}`);
      }

      for (let attempts = 0; attempts < 20; attempts += 1) {
        const txResult = await rpcServer.getTransaction(hash);
        if (txResult?.status === 'SUCCESS') {
          setTxStatus('success');
          setMessage('Donation successful.');
          await readCampaign();
          await loadWalletBalance();
          return;
        }
        if (txResult?.status === 'FAILED') {
          setTxStatus('failed');
          setMessage('Transaction failed on-chain.');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      setTxStatus('failed');
      setMessage('Transaction timed out while waiting for final status.');
    } catch (error: any) {
      setTxStatus('failed');
      if (error?.message?.includes('wallet_not_found')) {
        setMessage('Wallet not found. Connect a supported wallet first.');
      } else if (error?.message?.includes('rejected') || error?.message?.includes('cancel')) {
        setMessage('Transaction signing was rejected.');
      } else if (error?.message?.includes('Simulation failed')) {
        setMessage(error.message);
      } else {
        setMessage(`Donation failed. ${error?.message ?? 'Check wallet/RPC logs and try again.'}`);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (!publicKey) return;
    void loadWalletBalance();
    void readCampaign();
  }, [loadWalletBalance, publicKey, readCampaign]);

  useEffect(() => {
    const readInterval = setInterval(() => {
      void readCampaign();
      void pollEvents();
    }, 5000);
    return () => clearInterval(readInterval);
  }, [pollEvents, readCampaign]);

  const progress =
    campaign.goalStroops === 0n ? 0 : Math.min(100, Number((campaign.raisedStroops * 100n) / campaign.goalStroops));

  return (
    <main className="min-h-screen bg-gradient-to-br from-orange-50 via-amber-50 to-lime-50 text-slate-900">
      <section className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center p-6">
        <div className="w-full rounded-3xl border border-amber-200 bg-white p-6 shadow-xl md:p-10">
          <p className="text-sm font-semibold tracking-widest text-amber-700">STELLAR TESTNET CROWDFUND</p>
          <h1 className="mt-2 text-4xl font-black">Open Source Donation Campaign</h1>
          <p className="mt-3 text-slate-600">Multi-wallet integration, Soroban contract write/read, event-sync polling.</p>

          <div className="mt-6 grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl bg-amber-100 p-4">
              <p className="text-xs uppercase text-amber-700">Goal</p>
              <p className="text-2xl font-bold">{stroopsToXlm(campaign.goalStroops)} XLM</p>
            </div>
            <div className="rounded-2xl bg-emerald-100 p-4">
              <p className="text-xs uppercase text-emerald-700">Raised</p>
              <p className="text-2xl font-bold">{stroopsToXlm(campaign.raisedStroops)} XLM</p>
            </div>
            <div className="rounded-2xl bg-sky-100 p-4">
              <p className="text-xs uppercase text-sky-700">Donors</p>
              <p className="text-2xl font-bold">{campaign.donors}</p>
            </div>
          </div>

          <div className="mt-5 h-4 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-gradient-to-r from-amber-500 to-emerald-500 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="mt-6 rounded-2xl border border-slate-200 p-4">
            {!publicKey ? (
              <button
                onClick={connectWallet}
                className="w-full rounded-xl bg-slate-900 px-4 py-3 font-semibold text-white hover:bg-slate-700"
              >
                Connect Wallet (Freighter / Albedo / WalletConnect)
              </button>
            ) : (
              <div className="space-y-4">
                <div className="rounded-xl bg-slate-100 p-3">
                  <p className="text-sm text-slate-600">Connected wallet</p>
                  <p className="font-semibold">{shorten(publicKey)}</p>
                  <p className="text-sm text-slate-600">{nativeBalance} XLM</p>
                </div>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="Donation amount (XLM)"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-600"
                />
                <button
                  onClick={donate}
                  disabled={isSubmitting}
                  className="w-full rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSubmitting ? 'Processing...' : 'Donate'}
                </button>
                <button
                  onClick={() => {
                    setPublicKey('');
                    setNativeBalance('0');
                    setAmount('');
                    setMessage('');
                    setTxStatus('idle');
                    setTxHash('');
                  }}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 text-slate-700 hover:bg-slate-100"
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>

          <div className="mt-4 rounded-xl bg-slate-50 p-4 text-sm">
            <p>
              <span className="font-semibold">Status:</span> {txStatus.toUpperCase()}
            </p>
            {txHash ? (
              <p className="break-all">
                <span className="font-semibold">Tx Hash:</span>{' '}
                <a
                  href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sky-700 underline"
                >
                  {txHash}
                </a>
              </p>
            ) : null}
            <p className="mt-2 text-slate-700">{message || 'No activity yet.'}</p>
          </div>

          <div className="mt-4 text-xs text-slate-500">
            <p>Contract: {CONTRACT_ID || 'Set NEXT_PUBLIC_CONTRACT_ID'}</p>
            <p>RPC: {RPC_URL}</p>
          </div>
        </div>
      </section>
    </main>
  );
}
