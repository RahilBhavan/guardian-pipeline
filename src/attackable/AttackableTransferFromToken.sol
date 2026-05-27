// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  AttackableTransferFromToken — replants the bZx Sep 2020 transferFrom defect
/// @notice Demo-only attackable token used by `test/exploit/` (EXP-06). The
///         original bZx September 2020 iToken bug let a caller invoke
///         `transferFrom(self, self, amount)` to credit themselves without
///         debiting — the same-from-and-to branch ran the credit half of the
///         transfer with no balance check. This contract carries that
///         defect verbatim: anyone can mint themselves arbitrary balance.
/// @dev    Never deployed. EXP-06 uses this to demonstrate the historical
///         mechanism does drain on the broken surface, then runs the same
///         call on the canonical {MockERC20} (OpenZeppelin v5) and asserts
///         the call reverts and the runtime bytecode hash matches a stable
///         OZ-derived reference.
contract AttackableTransferFromToken {
    string public constant name = "bZx Replay Token";
    string public constant symbol = "BZRX";
    uint8 public constant decimals = 18;

    /// @notice ERC-20 total supply, in 1e18 units.
    uint256 public totalSupply;

    /// @notice ERC-20 balances.
    mapping(address => uint256) public balanceOf;

    /// @notice ERC-20 allowances.
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @notice Mint freely. Test-only.
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Standard ERC-20 approve.
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @notice Standard ERC-20 transfer.
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    /// @notice The bZx Sep 2020 defect, replanted: the `from == to` branch
    ///         credits `to` without debiting `from` and without an allowance
    ///         check, so any caller can mint themselves arbitrary balance.
    /// @dev    INTENTIONAL OMISSION: no balance debit, no allowance check in
    ///         the same-from-and-to branch. Anything else is standard ERC-20.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (from == to) {
            balanceOf[to] += amount;
            emit Transfer(from, to, amount);
            return true;
        }
        if (msg.sender != from) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
