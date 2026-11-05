// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract AtlasCountryProxy is ERC1967Proxy {
    constructor(address implementation, bytes memory initialization) ERC1967Proxy(implementation, initialization) {}
}
