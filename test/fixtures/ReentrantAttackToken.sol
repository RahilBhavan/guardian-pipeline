// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title  ReentrantAttackToken — ERC-777-style callback token for the harness
/// @notice Test-only ERC-20 that fires a reentrant callback during every
///         vault-initiated transfer and tries to reenter the configured
///         target. Used by {InvariantVault.invariant_reentrancySafe} to
///         prove the Vault's `nonReentrant` modifier actually blocks the
///         reentrant call sequence the canonical {MockERC20} can never
///         exercise — security-review finding GUA-01's outstanding gap.
/// @dev    OpenZeppelin v5 routes every balance change through {_update},
///         so the hook overrides that. The hook only fires when:
///           1. `active` is true
///           2. `target` is non-zero
///           3. the immediate caller (`msg.sender` to the token) IS the
///              target — i.e. the vault is currently moving the token as
///              part of one of its `nonReentrant` entrypoints
///           4. the hook is not already running (`_inHook` guard)
///         Counts only reverts whose selector matches OpenZeppelin's
///         {ReentrancyGuard.ReentrancyGuardReentrantCall} so the invariant
///         is load-bearing: removing the guard from the vault would make
///         the inner `deposit(1)` revert for a different reason (or
///         succeed), and `reentryAttempts != reentryReverts` would fire.
contract ReentrantAttackToken is ERC20 {
    /// @notice OpenZeppelin v5 {ReentrancyGuard.ReentrancyGuardReentrantCall}
    ///         selector — `bytes4(keccak256("ReentrancyGuardReentrantCall()"))`.
    bytes4 internal constant REENTRANCY_GUARD_SELECTOR = 0x3ee5aeb5;

    /// @notice The contract the hook reenters. Zero disables the hook.
    address public target;

    /// @notice Whether the hook is armed. Disable during setup so actor
    ///         funding mints do not fire the callback.
    bool public active;

    /// @notice Total reentry attempts the hook has made across this token's
    ///         lifetime. Read by `invariant_reentrancySafe`.
    uint256 public reentryAttempts;

    /// @notice Subset of {reentryAttempts} that reverted with the
    ///         OpenZeppelin {ReentrancyGuard} selector. The invariant fires
    ///         unless this equals {reentryAttempts}.
    uint256 public reentryReverts;

    /// @dev Re-entry guard local to the hook so the callback's own token
    ///      movements do not recurse forever.
    bool private _inHook;

    constructor() ERC20("Reentrant Attack Token", "rATK") {
        _mint(msg.sender, 1_000_000e18);
    }

    /// @notice Unrestricted mint — matches {MockERC20} for parity with the
    ///         rest of the test fixtures.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Point the hook at a Vault (or any nonReentrant target).
    function setTarget(address t) external {
        target = t;
    }

    /// @notice Arm or disarm the reentry hook. Disabled during setup.
    function setActive(bool a) external {
        active = a;
    }

    /// @dev Hook into every balance change. See contract-level docs for
    ///      the four conditions that must hold before the hook fires, and
    ///      why we count only the {ReentrancyGuard}-shaped revert.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (!active || target == address(0) || _inHook) return;
        // Only attempt to reenter when the vault itself is the immediate
        // caller — i.e. we are inside one of the vault's nonReentrant
        // entrypoints. Outside that window the hook would call an unguarded
        // contract and prove nothing.
        if (msg.sender != target) return;

        _inHook = true;
        reentryAttempts++;
        // `deposit(1)` is the cheapest nonReentrant entrypoint to reenter;
        // any of the seven would prove the property equally. We use a
        // low-level call so the revert does not bubble up and abort the
        // outer vault call — the outer call must complete for the campaign
        // to actually exercise state transitions.
        (bool ok, bytes memory data) = target.call(
            abi.encodeWithSignature("deposit(uint256)", uint256(1))
        );
        if (!ok && data.length >= 4) {
            bytes4 sel;
            // Inline-assembly is the standard way to lift the leading
            // selector out of a `bytes memory` revert payload.
            // solhint-disable-next-line no-inline-assembly
            assembly {
                sel := mload(add(data, 0x20))
            }
            if (sel == REENTRANCY_GUARD_SELECTOR) reentryReverts++;
        }
        _inHook = false;
    }
}
