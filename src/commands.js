const { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType } = require('discord.js');

const idOption = (o) =>
  o.setName('아이디').setDescription('백업 ID (입력하면 목록이 떠요)').setRequired(true).setAutocomplete(true);

const backup = new SlashCommandBuilder()
  .setName('백업')
  .setDescription('서버 백업 · 복구')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('생성')
      .setDescription('지금 이 서버를 백업해요')
      .addStringOption((o) => o.setName('메모').setDescription('백업에 붙일 메모').setMaxLength(100))
      .addIntegerOption((o) =>
        o.setName('메시지수').setDescription('채널마다 저장할 최근 메시지 수 (0~100, 기본은 자동백업 설정값)').setMinValue(0).setMaxValue(100),
      ),
  )
  .addSubcommand((s) => s.setName('목록').setDescription('내가 쓸 수 있는 백업 목록'))
  .addSubcommand((s) => s.setName('정보').setDescription('백업 내용 자세히 보기').addStringOption(idOption))
  .addSubcommand((s) =>
    s
      .setName('복구')
      .setDescription('백업으로 이 서버를 복구해요 (확인 버튼 한 번 더 누름)')
      .addStringOption((o) => o.setName('아이디').setDescription('복구할 백업 (입력하면 목록이 떠요)').setAutocomplete(true))
      .addAttachmentOption((o) => o.setName('파일').setDescription('/백업 다운로드로 받아둔 백업 파일로 복구'))
      .addStringOption((o) =>
        o
          .setName('모드')
          .setDescription('복구 방식 (기본: 전체 복구)')
          .addChoices(
            { name: '전체 복구 — 백업이랑 똑같이 맞춤 (없는 건 만들고, 백업에 없는 건 지움)', value: 'sync' },
            { name: '추가만 — 아무것도 안 지우고 없는 것만 추가', value: 'add' },
          ),
      )
      .addBooleanOption((o) => o.setName('메시지').setDescription('저장된 메시지도 복구 (기본: 켬)'))
      .addBooleanOption((o) =>
        o.setName('밴해제').setDescription('백업 이후 생긴 밴 풀기 — 테러로 밴당한 멤버 복구용, 같은 서버만 (기본: 끔)'),
      ),
  )
  .addSubcommand((s) =>
    s.setName('다운로드').setDescription('백업을 파일로 받기 (봇·DB가 날아가도 이 파일로 복구 가능)').addStringOption(idOption),
  )
  .addSubcommand((s) => s.setName('삭제').setDescription('백업 삭제').addStringOption(idOption));

const auto = new SlashCommandBuilder()
  .setName('자동백업')
  .setDescription('자동 백업 설정')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('설정')
      .setDescription('자동 백업 켜기 / 주기·보관 개수 바꾸기')
      .addIntegerOption((o) =>
        o
          .setName('주기')
          .setDescription('몇 시간마다 백업할지')
          .addChoices(
            { name: '1시간', value: 1 },
            { name: '3시간', value: 3 },
            { name: '6시간', value: 6 },
            { name: '12시간', value: 12 },
            { name: '24시간', value: 24 },
          ),
      )
      .addIntegerOption((o) => o.setName('보관').setDescription('자동 백업 몇 개까지 보관할지 (1~50)').setMinValue(1).setMaxValue(50))
      .addIntegerOption((o) =>
        o.setName('메시지수').setDescription('채널마다 저장할 최근 메시지 수 (0~100)').setMinValue(0).setMaxValue(100),
      ),
  )
  .addSubcommand((s) => s.setName('끄기').setDescription('자동 백업 끄기'))
  .addSubcommand((s) => s.setName('상태').setDescription('자동 백업 상태 · 다음 백업 시간'))
  .addSubcommand((s) =>
    s.setName('재개').setDescription('테러 감지로 멈춘 자동 백업 다시 시작 (지금 서버 상태로 바로 백업)'),
  );

module.exports = [backup.toJSON(), auto.toJSON()];
