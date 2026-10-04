// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title RiskQuoteVerifier
 * @dev EIP-712 verification for signed RiskQuotes produced off-chain by the
 * Python risk engine (quant/). A RiskQuote binds a notional, a required
 * collateral amount, a settlement asset, a settlement horizon, a model
 * version and a risk snapshot hash to a specific depositor/counterparty
 * pair, and is valid only until `quoteExpiration`.
 *
 * `quoteExpiration` and `settlementHorizon` answer two different questions
 * and must not be conflated: `quoteExpiration` is how long this quote may
 * be *accepted* (i.e. used to create an escrow); `settlementHorizon` is how
 * long, once accepted, the resulting escrow has to settle before it becomes
 * refundable. The risk engine prices `requiredCollateral` against the
 * latter, so it travels with the quote rather than being a contract-wide
 * constant (the engine will offer multiple horizons - 1d/7d/14d/30d, etc).
 *
 * This contract knows nothing about collateral transfer, fund custody or
 * escrow lifecycle - it only answers "was this exact quote signed by the
 * trusted risk oracle, and is it still valid?". RiskEscrow.sol is the
 * consumer that acts on that answer.
 */
abstract contract RiskQuoteVerifier is EIP712 {
    using ECDSA for bytes32;

    /**
     * @dev Signed risk quote. `settlementAsset` is the zero address for the
     * chain's native asset, or an ERC-20 token address otherwise.
     * `notional` and `requiredCollateral` are integers in the settlement
     * asset's smallest unit (wei-equivalent), computed off-chain by the risk
     * engine. `settlementHorizon` is a duration in seconds (e.g. 7 days),
     * not an absolute timestamp - the escrow's absolute settlement deadline
     * is computed on-chain as `createdAt + settlementHorizon`.
     * `riskSnapshotHash` is a keccak256 hash of the off-chain risk snapshot
     * the quote was priced from, kept on-chain for audit.
     */
    struct RiskQuote {
        bytes32 quoteId;
        address depositor;
        address counterparty;
        address settlementAsset;
        uint256 notional;
        uint256 requiredCollateral;
        uint256 quoteExpiration;
        uint256 settlementHorizon;
        string modelVersion;
        bytes32 riskSnapshotHash;
    }

    bytes32 private constant RISK_QUOTE_TYPEHASH = keccak256(
        "RiskQuote(bytes32 quoteId,address depositor,address counterparty,address settlementAsset,uint256 notional,uint256 requiredCollateral,uint256 quoteExpiration,uint256 settlementHorizon,string modelVersion,bytes32 riskSnapshotHash)"
    );

    address private _riskOracle;

    event RiskOracleUpdated(address indexed previousOracle, address indexed newOracle);

    constructor(string memory name, string memory version, address initialOracle) EIP712(name, version) {
        require(initialOracle != address(0), "Invalid risk oracle");
        _riskOracle = initialOracle;
        emit RiskOracleUpdated(address(0), initialOracle);
    }

    /// @notice Address of the key the risk engine signs RiskQuotes with.
    function riskOracle() public view returns (address) {
        return _riskOracle;
    }

    /// @notice EIP-712 digest for a given quote, under this contract's domain.
    function hashRiskQuote(RiskQuote calldata quote) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RISK_QUOTE_TYPEHASH,
                    quote.quoteId,
                    quote.depositor,
                    quote.counterparty,
                    quote.settlementAsset,
                    quote.notional,
                    quote.requiredCollateral,
                    quote.quoteExpiration,
                    quote.settlementHorizon,
                    keccak256(bytes(quote.modelVersion)),
                    quote.riskSnapshotHash
                )
            )
        );
    }

    /// @notice Recovers the signer of `signature` over `quote`, without checking who it is.
    function recoverRiskQuoteSigner(RiskQuote calldata quote, bytes calldata signature)
        public
        view
        returns (address)
    {
        return hashRiskQuote(quote).recover(signature);
    }

    /// @dev Reverts unless `quote` is unexpired and `signature` was produced by the risk oracle.
    function _verifyRiskQuote(RiskQuote calldata quote, bytes calldata signature) internal view {
        require(block.timestamp <= quote.quoteExpiration, "Risk quote expired");
        require(recoverRiskQuoteSigner(quote, signature) == _riskOracle, "Invalid risk quote signature");
    }

    function _setRiskOracle(address newOracle) internal {
        require(newOracle != address(0), "Invalid risk oracle");
        emit RiskOracleUpdated(_riskOracle, newOracle);
        _riskOracle = newOracle;
    }
}
