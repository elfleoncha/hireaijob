// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * AgentPayEscrow — escrow NO custodial para trabajos entre agentes.
 *
 * - El comprador deposita USDC en el contrato (el dinero no pasa por ninguna
 *   cuenta humana de la plataforma).
 * - El validador (la plataforma) sólo puede liberar o devolver: nunca mover
 *   fondos a un tercero ni cambiar el importe.
 * - El comprador puede recuperar su dinero si nadie libera antes del plazo.
 * - Importes en unidades del token (USDC = 6 decimales).
 *
 * No desplegado todavía: falta decidir red (Base) y quién firma como validador.
 */
interface IERC20 {
    function transferFrom(address, address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

contract AgentPayEscrow {
    enum State { None, Funded, Released, Refunded, Disputed }

    struct Job {
        address buyer;
        address agent;
        uint256 amount;
        uint64 deadline;
        State state;
    }

    IERC20 public immutable usdc;
    address public validator;
    address public feeWallet;
    uint16 public feeBps = 1000;          // 10 %
    uint256 public feeMin = 500_000;      // 0,5 USDC
    uint256 public feeMax = 50_000_000;   // 50 USDC

    mapping(bytes32 => Job) public jobs;

    event Funded(bytes32 indexed id, address buyer, uint256 amount);
    event AgentAssigned(bytes32 indexed id, address agent);
    event Released(bytes32 indexed id, uint256 toAgent, uint256 fee);
    event Refunded(bytes32 indexed id, address buyer);
    event Disputed(bytes32 indexed id, address buyer);

    error NotBuyer();
    error NotValidator();
    error BadState();
    error TooEarly();
    error TransferFailed();

    modifier onlyValidator() {
        if (msg.sender != validator) revert NotValidator();
        _;
    }

    constructor(address _usdc, address _validator, address _feeWallet) {
        usdc = IERC20(_usdc);
        validator = _validator;
        feeWallet = _feeWallet;
    }

    /// El comprador abre el trabajo y deja el dinero retenido. El agente se
    /// asigna cuando acepta (el validador firma la asignación).
    function fund(bytes32 id, uint256 amount, uint64 deadline) external {
        require(jobs[id].state == State.None, "exists");
        require(amount > 0, "params");
        require(usdc.transferFrom(msg.sender, address(this), amount), "transfer");
        jobs[id] = Job(msg.sender, address(0), amount, deadline, State.Funded);
        emit Funded(id, msg.sender, amount);
    }

    /// La plataforma asigna el agente/humano que ha aceptado el trabajo.
    function assignAgent(bytes32 id, address agent) external onlyValidator {
        Job storage j = jobs[id];
        if (j.state != State.Funded || j.agent != address(0)) revert BadState();
        require(agent != address(0), "agent");
        j.agent = agent;
        emit AgentAssigned(id, agent);
    }

    function comision(uint256 amount) public view returns (uint256) {
        uint256 fee = (amount * feeBps) / 10_000;
        if (fee < feeMin) fee = feeMin;
        if (fee > feeMax) fee = feeMax;
        if (fee > amount / 3) fee = amount / 3;
        return fee;
    }

    /// El validador confirma que la entrega pasó los filtros.
    function release(bytes32 id) external onlyValidator {
        Job storage j = jobs[id];
        if (j.state != State.Funded && j.state != State.Disputed) revert BadState();
        require(j.agent != address(0), "no agent");
        uint256 fee = comision(j.amount);
        j.state = State.Released;
        require(usdc.transfer(j.agent, j.amount - fee), "transfer");
        if (fee > 0) require(usdc.transfer(feeWallet, fee), "transfer");
        emit Released(id, j.amount - fee, fee);
    }

    /// Devolución: la pide el comprador (tras el plazo) o el validador (disputa).
    function refund(bytes32 id) external {
        Job storage j = jobs[id];
        if (j.state != State.Funded && j.state != State.Disputed) revert BadState();
        if (msg.sender != validator) {
            if (msg.sender != j.buyer) revert NotBuyer();
            if (block.timestamp < j.deadline) revert TooEarly();
        }
        j.state = State.Refunded;
        require(usdc.transfer(j.buyer, j.amount), "transfer");
        emit Refunded(id, j.buyer);
    }

    /// El comprador congela el pago: decide el validador con la evidencia.
    function dispute(bytes32 id) external {
        Job storage j = jobs[id];
        if (msg.sender != j.buyer) revert NotBuyer();
        if (j.state != State.Funded) revert BadState();
        j.state = State.Disputed;
        emit Disputed(id, j.buyer);
    }

    function setFee(uint16 bps, uint256 min, uint256 max) external onlyValidator {
        require(bps <= 2000, "fee");
        feeBps = bps;
        feeMin = min;
        feeMax = max;
    }

    function setValidator(address v) external onlyValidator {
        validator = v;
    }
}
