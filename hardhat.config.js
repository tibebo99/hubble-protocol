require("@nomiclabs/hardhat-waffle");
require('@nomiclabs/hardhat-web3')
require('hardhat-spdx-license-identifier')
require('solidity-coverage')
require("hardhat-gas-reporter")
require('hardhat-docgen')
require('hardhat-contract-sizer')
require("@tenderly/hardhat-tenderly");
require("@nomiclabs/hardhat-etherscan");

const PRIVATE_KEY = `0x${process.env.PRIVATE_KEY || 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'}`

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
    solidity: {
        version: "0.8.9",
        settings: {
            optimizer: {
                enabled: true,
                runs: 10000
            }
        }
    },
    networks: {
        /*** When forking fuji locally ***/
        // local: {
        //     url: 'http://localhost:8545',
        //     chainId: 31337
        // },
        // hardhat: {
        //     forking: {
        //         url: 'https://api.avax-test.network/ext/bc/C/rpc',
        //         chainId: 43113
        //     }
        // },
        local: {
            url: 'http://127.0.0.1:8545',
            chainId: 1337,
        },
        hardhat: {
            chainId: 1337
        },
        fuji: {
            url: 'https://api.avax-test.network/ext/bc/C/rpc',
            chainId: 43113,
            throwOnTransactionFailures: false,
            gasLimit: 6000000,
            accounts: [ PRIVATE_KEY ]
        },
    },
    etherscan: {
        apiKey: `${process.env.ETHERSCAN || ''}`
    },
    spdxLicenseIdentifier: {
        runOnCompile: true
    },
    gasReporter: {
        currency: 'USD',
        gasPrice: 25,
        coinmarketcap: '554a6764-aae9-440e-852b-63e3c66c20d7',
        token: 'AVAX',
        enabled: process.env.REPORT_GAS ? true : false
    },
    docgen: {
        clear: true,
    },
    tenderly: {
        project: "Supernova",
        username: "atvanguard",
    }
};
