// Package events decodes RiskEscrow.sol logs using the contract's actual
// compiled ABI (internal/events/abi/risk_escrow.json, extracted from
// artifacts/contracts/RiskEscrow.sol/RiskEscrow.json after `npx hardhat
// compile` - not hand-invented event names).
//
// Six events are indexed, matching the deployed contract's lifecycle:
// RiskEscrowCreated, RiskEscrowSettled, RiskEscrowRefunded (deal-scoped),
// and RiskOracleUpdated, PlatformFeeUpdated, PlatformWalletUpdated
// (contract-level config, not deal-scoped). OwnershipTransferred and
// EIP712DomainChanged also appear in the full ABI but are out of scope:
// they carry no escrow-lifecycle or risk-collateral information.
package events

import (
	"bytes"
	_ "embed"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

//go:embed abi/risk_escrow.json
var riskEscrowABIJSON []byte

// ContractABI is the parsed ABI of the six indexed RiskEscrow events.
var ContractABI abi.ABI

// Event names, exactly as declared in RiskEscrow.sol / RiskQuoteVerifier.sol.
const (
	EventRiskEscrowCreated     = "RiskEscrowCreated"
	EventRiskEscrowSettled     = "RiskEscrowSettled"
	EventRiskEscrowRefunded    = "RiskEscrowRefunded"
	EventRiskOracleUpdated     = "RiskOracleUpdated"
	EventPlatformFeeUpdated    = "PlatformFeeUpdated"
	EventPlatformWalletUpdated = "PlatformWalletUpdated"
)

// topicToEventName maps a log's topic0 (event signature hash) to its name,
// built once at init from ContractABI so it can never drift from the ABI.
var topicToEventName map[common.Hash]string

func init() {
	parsed, err := abi.JSON(bytes.NewReader(riskEscrowABIJSON))
	if err != nil {
		panic(fmt.Sprintf("events: failed to parse embedded RiskEscrow ABI: %v", err))
	}
	ContractABI = parsed

	topicToEventName = make(map[common.Hash]string, len(ContractABI.Events))
	for name, ev := range ContractABI.Events {
		topicToEventName[ev.ID] = name
	}
}

// EventNameForLog returns the decoded event name for a log's topic0, or
// ("", false) if the log does not match any of the six indexed events
// (e.g. OwnershipTransferred, or a log from an unrelated contract).
func EventNameForLog(log types.Log) (string, bool) {
	if len(log.Topics) == 0 {
		return "", false
	}
	name, ok := topicToEventName[log.Topics[0]]
	return name, ok
}

// RiskEscrowCreated mirrors the contract event of the same name.
type RiskEscrowCreated struct {
	DealId             *big.Int
	QuoteId            [32]byte
	Depositor          common.Address
	Counterparty       common.Address
	SettlementAsset    common.Address
	Notional           *big.Int
	CollateralLocked   *big.Int
	SettlementDeadline *big.Int
	ModelVersion       string
	RiskSnapshotHash   [32]byte
}

// RiskEscrowSettled mirrors the contract event of the same name.
type RiskEscrowSettled struct {
	DealId          *big.Int
	Counterparty    common.Address
	Payout          *big.Int
	PlatformFee     *big.Int
	DepositorRefund *big.Int
}

// RiskEscrowRefunded mirrors the contract event of the same name.
type RiskEscrowRefunded struct {
	DealId    *big.Int
	Depositor common.Address
	Amount    *big.Int
}

// RiskOracleUpdated mirrors the contract event of the same name.
type RiskOracleUpdated struct {
	PreviousOracle common.Address
	NewOracle      common.Address
}

// PlatformFeeUpdated mirrors the contract event of the same name.
type PlatformFeeUpdated struct {
	PreviousFeeBps *big.Int
	NewFeeBps      *big.Int
}

// PlatformWalletUpdated mirrors the contract event of the same name.
type PlatformWalletUpdated struct {
	PreviousWallet common.Address
	NewWallet      common.Address
}

// unpack decodes a log's non-indexed data into dest, then overlays the
// indexed topic fields. This is the same two-step approach abigen-generated
// bindings use internally (abi.ABI.UnpackIntoInterface handles non-indexed
// fields from Data; indexed fields must be parsed from Topics separately).
func unpack(eventName string, log types.Log, dest interface{}) error {
	ev, ok := ContractABI.Events[eventName]
	if !ok {
		return fmt.Errorf("events: unknown event %q", eventName)
	}
	if len(log.Topics) == 0 || log.Topics[0] != ev.ID {
		return fmt.Errorf("events: log topic0 does not match event %q", eventName)
	}

	if err := ContractABI.UnpackIntoInterface(dest, eventName, log.Data); err != nil {
		return fmt.Errorf("events: unpack non-indexed fields of %q: %w", eventName, err)
	}

	var indexed abi.Arguments
	for _, arg := range ev.Inputs {
		if arg.Indexed {
			indexed = append(indexed, arg)
		}
	}
	if len(indexed) > 0 {
		if err := abi.ParseTopics(dest, indexed, log.Topics[1:]); err != nil {
			return fmt.Errorf("events: parse indexed topics of %q: %w", eventName, err)
		}
	}
	return nil
}

// DecodeRiskEscrowCreated decodes a RiskEscrowCreated log.
func DecodeRiskEscrowCreated(log types.Log) (RiskEscrowCreated, error) {
	var out RiskEscrowCreated
	err := unpack(EventRiskEscrowCreated, log, &out)
	return out, err
}

// DecodeRiskEscrowSettled decodes a RiskEscrowSettled log.
func DecodeRiskEscrowSettled(log types.Log) (RiskEscrowSettled, error) {
	var out RiskEscrowSettled
	err := unpack(EventRiskEscrowSettled, log, &out)
	return out, err
}

// DecodeRiskEscrowRefunded decodes a RiskEscrowRefunded log.
func DecodeRiskEscrowRefunded(log types.Log) (RiskEscrowRefunded, error) {
	var out RiskEscrowRefunded
	err := unpack(EventRiskEscrowRefunded, log, &out)
	return out, err
}

// DecodeRiskOracleUpdated decodes a RiskOracleUpdated log.
func DecodeRiskOracleUpdated(log types.Log) (RiskOracleUpdated, error) {
	var out RiskOracleUpdated
	err := unpack(EventRiskOracleUpdated, log, &out)
	return out, err
}

// DecodePlatformFeeUpdated decodes a PlatformFeeUpdated log.
func DecodePlatformFeeUpdated(log types.Log) (PlatformFeeUpdated, error) {
	var out PlatformFeeUpdated
	err := unpack(EventPlatformFeeUpdated, log, &out)
	return out, err
}

// DecodePlatformWalletUpdated decodes a PlatformWalletUpdated log.
func DecodePlatformWalletUpdated(log types.Log) (PlatformWalletUpdated, error) {
	var out PlatformWalletUpdated
	err := unpack(EventPlatformWalletUpdated, log, &out)
	return out, err
}
