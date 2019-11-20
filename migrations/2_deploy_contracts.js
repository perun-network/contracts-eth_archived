var AssetHolderETH = artifacts.require("AssetHolderETH");

module.exports = function(deployer, network, accounts) {
  deployer.deploy(AssetHolderETH, accounts[0]);
};
