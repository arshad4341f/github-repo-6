// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract ArbitrageBot {
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not the owner");
        _;
    }

    function executeArbitrage(address token, uint256 amount, address dex1, address dex2) external onlyOwner {
        // Implement arbitrage logic here
    }

    function withdrawProfit() external onlyOwner {
        payable(owner).transfer(address(this).balance);
    }

    receive() external payable {}
}
