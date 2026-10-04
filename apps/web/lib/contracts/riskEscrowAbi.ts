// GENERATED FILE - do not edit by hand.
// Source: artifacts/contracts/RiskEscrow.sol/RiskEscrow.json (npm run compile)
// Regenerate with: npm run abi:export
//
// The full compiled ABI, not a hand-maintained subset - includes every
// event (RiskEscrowCreated/Settled/Refunded, oracle/fee/wallet config
// updates) alongside the functions, so a frontend watching contract
// events or calling a newly added view function never silently drifts
// from what RiskEscrow.sol actually exposes.

export const riskEscrowAbi = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_platformWallet",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "_riskOracle",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "ECDSAInvalidSignature",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "length",
        "type": "uint256"
      }
    ],
    "name": "ECDSAInvalidSignatureLength",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "s",
        "type": "bytes32"
      }
    ],
    "name": "ECDSAInvalidSignatureS",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidShortString",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "owner",
        "type": "address"
      }
    ],
    "name": "OwnableInvalidOwner",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "OwnableUnauthorizedAccount",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReentrancyGuardReentrantCall",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      }
    ],
    "name": "SafeERC20FailedOperation",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "str",
        "type": "string"
      }
    ],
    "name": "StringTooLong",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [],
    "name": "EIP712DomainChanged",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "previousOwner",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "newOwner",
        "type": "address"
      }
    ],
    "name": "OwnershipTransferred",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "previousFeeBps",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "newFeeBps",
        "type": "uint256"
      }
    ],
    "name": "PlatformFeeUpdated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "previousWallet",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "newWallet",
        "type": "address"
      }
    ],
    "name": "PlatformWalletUpdated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "dealId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "quoteId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "depositor",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "counterparty",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "settlementAsset",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "notional",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "collateralLocked",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "settlementDeadline",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "modelVersion",
        "type": "string"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "riskSnapshotHash",
        "type": "bytes32"
      }
    ],
    "name": "RiskEscrowCreated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "dealId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "depositor",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "RiskEscrowRefunded",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "dealId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "counterparty",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "payout",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "platformFee",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "depositorRefund",
        "type": "uint256"
      }
    ],
    "name": "RiskEscrowSettled",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "previousOracle",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "newOracle",
        "type": "address"
      }
    ],
    "name": "RiskOracleUpdated",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "MAX_FEE_BPS",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_SETTLEMENT_HORIZON",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MIN_SETTLEMENT_HORIZON",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "bytes32",
            "name": "quoteId",
            "type": "bytes32"
          },
          {
            "internalType": "address",
            "name": "depositor",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "counterparty",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "settlementAsset",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "notional",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "requiredCollateral",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "quoteExpiration",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "settlementHorizon",
            "type": "uint256"
          },
          {
            "internalType": "string",
            "name": "modelVersion",
            "type": "string"
          },
          {
            "internalType": "bytes32",
            "name": "riskSnapshotHash",
            "type": "bytes32"
          }
        ],
        "internalType": "struct RiskQuoteVerifier.RiskQuote",
        "name": "quote",
        "type": "tuple"
      },
      {
        "internalType": "bytes",
        "name": "signature",
        "type": "bytes"
      }
    ],
    "name": "createEscrow",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "dealId",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "dealCounter",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "name": "deals",
    "outputs": [
      {
        "internalType": "address",
        "name": "depositor",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "counterparty",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "settlementAsset",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "notional",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "collateralLocked",
        "type": "uint256"
      },
      {
        "internalType": "string",
        "name": "modelVersion",
        "type": "string"
      },
      {
        "internalType": "bytes32",
        "name": "riskSnapshotHash",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "quoteId",
        "type": "bytes32"
      },
      {
        "internalType": "enum RiskEscrow.EscrowStatus",
        "name": "status",
        "type": "uint8"
      },
      {
        "internalType": "uint256",
        "name": "createdAt",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "settlementDeadline",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "settledAt",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "eip712Domain",
    "outputs": [
      {
        "internalType": "bytes1",
        "name": "fields",
        "type": "bytes1"
      },
      {
        "internalType": "string",
        "name": "name",
        "type": "string"
      },
      {
        "internalType": "string",
        "name": "version",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "chainId",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "verifyingContract",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "salt",
        "type": "bytes32"
      },
      {
        "internalType": "uint256[]",
        "name": "extensions",
        "type": "uint256[]"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "asset",
        "type": "address"
      }
    ],
    "name": "emergencyWithdraw",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "asset",
        "type": "address"
      }
    ],
    "name": "getContractBalance",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "dealId",
        "type": "uint256"
      }
    ],
    "name": "getDeal",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "depositor",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "counterparty",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "settlementAsset",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "notional",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "collateralLocked",
            "type": "uint256"
          },
          {
            "internalType": "string",
            "name": "modelVersion",
            "type": "string"
          },
          {
            "internalType": "bytes32",
            "name": "riskSnapshotHash",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "quoteId",
            "type": "bytes32"
          },
          {
            "internalType": "enum RiskEscrow.EscrowStatus",
            "name": "status",
            "type": "uint8"
          },
          {
            "internalType": "uint256",
            "name": "createdAt",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "settlementDeadline",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "settledAt",
            "type": "uint256"
          }
        ],
        "internalType": "struct RiskEscrow.RiskEscrowDeal",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "bytes32",
            "name": "quoteId",
            "type": "bytes32"
          },
          {
            "internalType": "address",
            "name": "depositor",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "counterparty",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "settlementAsset",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "notional",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "requiredCollateral",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "quoteExpiration",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "settlementHorizon",
            "type": "uint256"
          },
          {
            "internalType": "string",
            "name": "modelVersion",
            "type": "string"
          },
          {
            "internalType": "bytes32",
            "name": "riskSnapshotHash",
            "type": "bytes32"
          }
        ],
        "internalType": "struct RiskQuoteVerifier.RiskQuote",
        "name": "quote",
        "type": "tuple"
      }
    ],
    "name": "hashRiskQuote",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "dealId",
        "type": "uint256"
      }
    ],
    "name": "isRefundable",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "dealId",
        "type": "uint256"
      }
    ],
    "name": "isSettleable",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "owner",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "platformFeeBps",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "platformWallet",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "bytes32",
            "name": "quoteId",
            "type": "bytes32"
          },
          {
            "internalType": "address",
            "name": "depositor",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "counterparty",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "settlementAsset",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "notional",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "requiredCollateral",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "quoteExpiration",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "settlementHorizon",
            "type": "uint256"
          },
          {
            "internalType": "string",
            "name": "modelVersion",
            "type": "string"
          },
          {
            "internalType": "bytes32",
            "name": "riskSnapshotHash",
            "type": "bytes32"
          }
        ],
        "internalType": "struct RiskQuoteVerifier.RiskQuote",
        "name": "quote",
        "type": "tuple"
      },
      {
        "internalType": "bytes",
        "name": "signature",
        "type": "bytes"
      }
    ],
    "name": "recoverRiskQuoteSigner",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "dealId",
        "type": "uint256"
      }
    ],
    "name": "refund",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "renounceOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "riskOracle",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "newOracle",
        "type": "address"
      }
    ],
    "name": "setRiskOracle",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "dealId",
        "type": "uint256"
      }
    ],
    "name": "settle",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "asset",
        "type": "address"
      }
    ],
    "name": "surplusBalance",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "totalLocked",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "newOwner",
        "type": "address"
      }
    ],
    "name": "transferOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "newFeeBps",
        "type": "uint256"
      }
    ],
    "name": "updatePlatformFee",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "newWallet",
        "type": "address"
      }
    ],
    "name": "updatePlatformWallet",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "name": "usedQuotes",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const;
