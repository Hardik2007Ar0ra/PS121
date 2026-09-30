export const risks = [
 {name:'Stuck Pipe',level:'High',score:78,start:2870,end:2950,pattern:'Two analogous wells recorded pack-off / stuck pipe within the upcoming interval.',events:['Well C — Stuck Pipe at 2,900 m','Well D — High Torque at 2,870 m'],telemetry:'Torque trending upward; ROP remains within the synthetic operating band.'},
 {name:'Lost Circulation',level:'Medium',score:43,start:2860,end:2900,pattern:'Offset reports show mud-loss indicators near the upper boundary.',events:['Well B — Mud Loss at 2,880 m','Well D — Mud Loss at 2,760 m'],telemetry:'Flow and standpipe pressure are stable in this demo snapshot.'},
 {name:'Kick',level:'Low',score:18,start:2940,end:2970,pattern:'One historical kick record is present near the interval.',events:['Well B — Kick at 2,950 m'],telemetry:'No synthetic flow anomaly is active.'},
 {name:'Formation Instability',level:'Medium',score:51,start:2900,end:2950,pattern:'One offset report notes instability in Formation X.',events:['Well D — Formation Instability at 2,920 m'],telemetry:'Synthetic torque and ROP trends provide context only.'},
]
