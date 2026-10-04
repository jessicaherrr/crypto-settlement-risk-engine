// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Forces native-asset value into a target via `selfdestruct`,
/// bypassing any receive/fallback restriction, so tests can simulate stray
/// ETH landing on RiskEscrow and confirm emergencyWithdraw treats it as
/// surplus without ever touching escrowed collateral. Not deployed as part
/// of the production system.
contract ForceSend {
    constructor() payable {}

    function destroy(address payable target) external {
        selfdestruct(target);
    }
}
