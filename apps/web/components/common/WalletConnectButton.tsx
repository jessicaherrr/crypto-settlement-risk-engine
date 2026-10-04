// components/common/WalletConnectButton.tsx
'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useBalance } from 'wagmi';
import { ACTIVE_CHAIN } from '@/lib/chain/config';

export default function WalletConnectButton() {
  const { address } = useAccount();
  const { data: balance } = useBalance({
    address,
    chainId: ACTIVE_CHAIN.id,
  });

  // Custom connect button for better UI integration
  return (
    <ConnectButton.Custom>
      {({
        account,
        chain: connectedChain,
        openAccountModal,
        openChainModal,
        openConnectModal,
        authenticationStatus,
        mounted,
      }) => {
        const ready = mounted && authenticationStatus !== 'loading';
        const connected = ready && account && connectedChain;

        return (
          <div
            {...(!ready && {
              'aria-hidden': true,
              style: {
                opacity: 0,
                pointerEvents: 'none',
                userSelect: 'none',
              },
            })}
          >
            {(() => {
              if (!connected) {
                return (
                  <button
                    onClick={openConnectModal}
                    className="rounded-md border border-slate-700 bg-slate-800 px-4 py-1.5 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-700"
                    type="button"
                  >
                    Connect wallet
                  </button>
                );
              }

              if (connectedChain.unsupported) {
                return (
                  <button
                    onClick={openChainModal}
                    className="rounded-md border border-status-critical/40 bg-status-critical/10 px-4 py-1.5 text-sm font-medium text-status-critical transition-colors hover:bg-status-critical/20"
                    type="button"
                  >
                    Wrong network
                  </button>
                );
              }

              return (
                <div className="flex items-center gap-2">
                  <button
                    onClick={openChainModal}
                    className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-800"
                    type="button"
                  >
                    {connectedChain.hasIcon && connectedChain.iconUrl && (
                      // eslint-disable-next-line @next/next/no-img-element -- small, dynamic per-chain icon, not worth next/image's config here
                      <img
                        alt={connectedChain.name ?? 'Chain icon'}
                        src={connectedChain.iconUrl}
                        className="h-4 w-4 rounded-full"
                      />
                    )}
                    {connectedChain.name}
                  </button>

                  <button
                    onClick={openAccountModal}
                    className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-700"
                    type="button"
                  >
                    <span>{account.displayName}</span>
                    <span className="font-mono text-xs text-slate-400">
                      {balance?.formatted.slice(0, 6)} {balance?.symbol}
                    </span>
                  </button>
                </div>
              );
            })()}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
